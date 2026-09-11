import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', '**/.cache/**'] },
  {
    files: ['**/*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    // Determinism guard: the engine must not read ambient time or use
    // non-reproducible / runtime-varying math. See PLAN.md section 5.3.
    //
    // What this buys: a tripwire on the obvious spellings of an ambient read —
    // `Math.random()`, `Date.now()`, `new Date()`, `Date()`, `performance.now()`,
    // `process.hrtime()`, and the transcendental `Math.*` family. Computed
    // member access (`Math['random']`) and object destructuring
    // (`const { random } = Math`) are caught too.
    //
    // Residual, UNENFORCED gaps — these defeat a lint rule that compares
    // member-access names, and are covered by review and by the golden-hash
    // gate (packages/testing/test/golden.test.ts) instead of by this config:
    //   - aliasing the namespace: `const M = Math; M.random()`,
    //     `const D = Date; new D()`;
    //   - reaching the global object first: `globalThis.Math.random()`;
    //   - fully computed indirection: `const k = 'random'; Math[k]()`;
    //   - exponentiation via the `**` operator (pow semantics);
    //   - anything smuggled through a string (`eval`, `Function`) or `globalThis`.
    // Documenting the limit is the point: this is a guardrail, not a sandbox.
    //
    // `packages/sim` is included because it is **simulation infrastructure**, where
    // the determinism rule is total rather than merely advisable: a run must be a pure
    // function of `(seed, settings, ruleset, policies)`, so an ambient read anywhere in
    // its `src/` would make a balance number unreproducible. It was outside this
    // `files` list when the package landed — `Math.random()` in its `src/` linted
    // clean, which is exactly the "a new package that escapes the gate" failure this
    // guard exists to prevent. `packages/sim/test/**` is deliberately NOT listed: a
    // test may legitimately *measure* the harness with a clock (the invariant-cost
    // probe in `test/harness-adversarial.test.ts` does), and a ban that stopped a test
    // from timing anything would be a ban on evidence. The shipped scripts are not
    // listed either, for the same reason — they report, they do not simulate.
    files: ['packages/core/src/**/*.ts', 'packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use the seeded RNG carried in GameState.' },
        { object: 'Date', property: 'now', message: 'Engine must be deterministic: no ambient time.' },
        { object: 'performance', property: 'now', message: 'Engine must be deterministic: no ambient time.' },
        { object: 'process', property: 'hrtime', message: 'Engine must be deterministic: no ambient time (process.hrtime is a monotonic clock).' },
        { object: 'Math', property: 'pow', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'sin', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'cos', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'log', message: 'Determinism: transcendentals vary across runtimes.' },
        { object: 'Math', property: 'exp', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'tan', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'atan', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'atan2', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'asin', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'acos', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'sinh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'cosh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'tanh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'asinh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'acosh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'atanh', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'log2', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'log10', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'log1p', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'expm1', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'cbrt', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
        { object: 'Math', property: 'hypot', message: 'Determinism: transcendentals are not portable across runtimes (each engine ships its own libm).' },
      ],
      // `new Date()` and `Date()` are constructor/function calls, not property
      // accesses, so `no-restricted-properties` cannot see them.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='Date']",
          message: 'Engine must be deterministic: no ambient time (new Date() reads the wall clock).',
        },
        {
          selector: "CallExpression[callee.name='Date']",
          message: 'Engine must be deterministic: no ambient time (Date() reads the wall clock).',
        },
      ],
      // Belt-and-braces: catches any other `Date` reference (including a bare
      // `Date` value passed around or aliased as `const D = Date`), which is
      // how the `Date` half of the residual aliasing gap above is closed. It
      // overlaps `no-restricted-properties` on `Date.now()` and the syntax
      // selectors on `new Date()`/`Date()`, so those report twice; the
      // redundancy is deliberate (defence in depth, and the extra message names
      // the aliasing case). Verified by probe; it uses identifier resolution, so
      // it fires only when `Date` resolves to a declared global and it does NOT
      // fire on a type-position `Date` annotation.
      'no-restricted-globals': [
        'error',
        {
          name: 'Date',
          message: 'Engine must be deterministic: no ambient time (the Date global reads the wall clock).',
        },
      ],
    },
  },
  {
    files: ['**/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
);
