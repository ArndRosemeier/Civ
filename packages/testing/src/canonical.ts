/**
 * Canonical JSON: a deterministic serialization used for state hashing.
 * See PLAN.md §5.3 and docs/INTERFACES.md (workstream W2).
 *
 * The rules are deliberately narrow — state must be plain data:
 *
 * - object keys are sorted recursively (UTF-16 code-unit order),
 * - array order is preserved,
 * - only `null`, `boolean`, `string`, finite `number`, plain objects, arrays
 *   and numeric typed arrays are representable,
 * - `undefined`, functions, symbols, `bigint`, `NaN`, `±Infinity`, class
 *   instances, `Date`, `Map`, `Set`, `RegExp`, … are rejected loudly rather
 *   than silently coerced (JSON.stringify would drop or null them, which would
 *   make two different states hash the same),
 * - accessor properties (a `get` or `set` in the property descriptor) are
 *   rejected instead of being read. Invoking a getter would make the "hash" a
 *   function of code with side effects rather than of value: a getter that
 *   counts calls or reads a clock returns different data on every invocation,
 *   so the same object would hash differently each time. Only own *data*
 *   properties are read, and reads go through the descriptor check first, so no
 *   getter is ever invoked on the way to the rejection.
 *
 * Limits of that check, stated rather than implied:
 *
 * - Only own *enumerable* string keys are inspected (that is all canonical JSON
 *   covers), so a non-enumerable accessor is silently ignored — and, crucially,
 *   never invoked,
 * - a `Proxy` whose target is a plain object still passes the plain-object test
 *   and can run arbitrary traps (`ownKeys`, `getOwnPropertyDescriptor`, `get`)
 *   before this module sees anything; rejecting accessors cannot defend against
 *   a hostile proxy, and a Proxy is not plain data by intent even though it
 *   cannot be detected reliably.
 *
 * Pure functions only: no filesystem, no ambient time, no ambient randomness.
 */

/** Path prefix used in thrown messages so a bad state is easy to locate. */
const ROOT = '$';

const fail = (path: string, reason: string): never => {
  throw new Error(`canonicalize: ${reason} [at ${path}]`);
};

/**
 * JSON string quoting. `JSON.stringify` escapes control characters and lone
 * surrogates (well-formed JSON.stringify), which keeps distinct strings from
 * collapsing onto the same UTF-8 bytes after TextEncoder.
 */
const quote = (value: string): string => {
  const encoded: unknown = JSON.stringify(value);
  if (typeof encoded !== 'string') {
    throw new Error('canonicalize: internal error: string encoding produced no text');
  }
  return encoded;
};

const encodeNumber = (value: number, path: string): string => {
  if (Number.isNaN(value)) {
    return fail(path, 'NaN is not representable in canonical JSON');
  }
  if (!Number.isFinite(value)) {
    return fail(path, `${value > 0 ? 'Infinity' : '-Infinity'} is not representable in canonical JSON`);
  }
  // `String(-0)` is '0', matching JSON and folding -0 and 0 onto one form.
  return String(value);
};

/** `null`-prototype or `Object.prototype` objects only — no class instances. */
const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

const objectTag = (value: object): string => Object.prototype.toString.call(value);

/**
 * Numeric typed arrays (PLAN.md §5.4 map layer) serialize exactly like the
 * equivalent plain number array. Float views may still hold NaN/Infinity, which
 * `encodeNumber` rejects.
 */
const numericView = (value: object): ArrayLike<number> | undefined =>
  value instanceof Int8Array ||
  value instanceof Uint8Array ||
  value instanceof Uint8ClampedArray ||
  value instanceof Int16Array ||
  value instanceof Uint16Array ||
  value instanceof Int32Array ||
  value instanceof Uint32Array ||
  value instanceof Float32Array ||
  value instanceof Float64Array
    ? value
    : undefined;

const encodeArrayLike = (
  items: ArrayLike<unknown>,
  path: string,
  stack: Set<object>,
): string => {
  const parts: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    parts.push(encodeValue(items[i], `${path}[${String(i)}]`, stack));
  }
  return `[${parts.join(',')}]`;
};

/**
 * Encodes one own enumerable string key of a plain record.
 *
 * The property descriptor is consulted *before* the value is read, which does
 * two things: accessor properties are rejected by inspecting their shape (so
 * their getter is never invoked — `record[key]` would run it), and data
 * properties are read exactly as before, so this adds a rejection path without
 * changing the encoding of any value that was already accepted.
 */
const encodeProperty = (
  record: Record<string, unknown>,
  key: string,
  path: string,
  stack: Set<object>,
): string => {
  const childPath = `${path}.${key}`;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined) {
    return fail(childPath, 'internal error: own enumerable key has no property descriptor');
  }
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    return fail(
      childPath,
      'accessor property (getter/setter) is not plain data — a hash must be a pure function of value, so getters are never invoked',
    );
  }
  return `${quote(key)}:${encodeValue(record[key], childPath, stack)}`;
};

const encodeRecord = (record: Record<string, unknown>, path: string, stack: Set<object>): string => {
  const symbols = Object.getOwnPropertySymbols(record);
  if (symbols.length > 0) {
    return fail(path, 'symbol-keyed properties are not plain data');
  }
  // Default sort: ascending UTF-16 code units — stable and locale-independent.
  const keys = Object.keys(record).sort();
  const parts = keys.map((key) => encodeProperty(record, key, path, stack));
  return `{${parts.join(',')}}`;
};

const encodeObject = (value: object, path: string, stack: Set<object>): string => {
  if (stack.has(value)) {
    return fail(path, 'circular reference');
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const items: readonly unknown[] = value;
      return encodeArrayLike(items, path, stack);
    }
    if (value instanceof BigInt64Array || value instanceof BigUint64Array) {
      return fail(path, 'BigInt typed arrays are not representable in canonical JSON');
    }
    const numbers = numericView(value);
    if (numbers !== undefined) {
      return encodeArrayLike(numbers, path, stack);
    }
    if (isPlainObject(value)) {
      return encodeRecord(value, path, stack);
    }
    return fail(path, `unsupported object type ${objectTag(value)} — state must be plain data`);
  } finally {
    stack.delete(value);
  }
};

const encodeValue = (value: unknown, path: string, stack: Set<object>): string => {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return quote(value);
    case 'number':
      return encodeNumber(value, path);
    case 'object':
      return encodeObject(value, path, stack);
    case 'undefined':
      return fail(path, 'undefined is not representable in canonical JSON');
    case 'function':
      return fail(path, 'functions are not plain data');
    case 'symbol':
      return fail(path, 'symbols are not plain data');
    case 'bigint':
      return fail(path, 'bigint is not representable in canonical JSON');
    default:
      return fail(path, 'unsupported value');
  }
};

/**
 * Deterministic JSON with object keys sorted recursively. Throws on
 * undefined/function/symbol/BigInt/NaN/Infinity — state must be plain data.
 * Also throws on accessor properties (getters/setters) rather than invoking
 * them: a hash has to be a pure function of the value, not of code that can
 * return something different on every read.
 */
export function canonicalize(value: unknown): string {
  return encodeValue(value, ROOT, new Set<object>());
}
