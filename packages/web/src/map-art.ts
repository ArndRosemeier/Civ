/** Small original vector illustrations for the map's previously invisible objects. */
const svg = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g stroke="#352c24" stroke-width="1.5" stroke-linejoin="round">${body}</g></svg>`;

const house = (x: number, y: number, scale = 1): string =>
  `<g transform="translate(${String(x)} ${String(y)}) scale(${String(scale)})"><path fill="#cdb994" d="M0 8 12 3 24 8 24 24 12 29 0 24Z"/><path fill="#a8916f" d="M12 13 24 8 24 24 12 29Z"/><path fill="#985741" d="M-2 8 11-2 26 8 12 14Z"/><path fill="#4b4035" d="M4 17 8 18 8 25 4 24Z M16 16 20 14 20 19 16 21Z"/></g>`;

export const MAP_ART: Readonly<Record<string, string>> = {
  hut: svg(
    '<ellipse stroke="none" fill="#17261e" opacity=".25" cx="32" cy="53" rx="27" ry="7"/><path fill="#ab8b54" d="M8 29 32 19 55 29 55 48 32 56 8 47Z"/><path fill="#725a35" d="M32 37 55 29 55 48 32 56Z"/><path fill="#d0b16c" d="M4 30 30 7 59 30 32 40Z"/><path fill="none" stroke="#98763f" d="m12 28 19-16 20 18 M20 33 31 17 12 22 M39 35 32 16 51 24"/><path fill="#302e24" d="M26 43 35 40 35 54 26 52Z"/>',
  ),
  mine: svg(
    '<ellipse stroke="none" fill="#17261e" opacity=".3" cx="32" cy="53" rx="27" ry="7"/><path fill="#777569" d="M5 48 12 22 31 11 49 25 58 49Z"/><path fill="#b1a994" d="m12 22 19-11 18 14-19-5-13 13Z"/><path fill="#232b2c" d="M21 49V31l12-6 12 8v16Z"/><path fill="none" stroke="#a47d4f" stroke-width="5" d="M20 49V30l14-6 13 8v17"/><path stroke="#acaba1" stroke-width="2" d="m20 55 8-17 m20 17-11-17 m-14 6h21 m-23 5h26"/>',
  ),
  irrigation: svg(
    '<path fill="#b4a35d" d="m3 16 31-12 28 13-30 14Z M3 21l29 14 30-14v24L32 59 3 44Z"/><path stroke="#668445" stroke-width="3" d="m7 24 24 12 m-24-6 24 12 m-24-6 24 12 m7-13 20-9 m-20 15 20-9 m-20 15 20-9"/><path fill="none" stroke="#78c8ce" stroke-width="3" d="M3 17 32 31 61 17 M32 31v28"/>',
  ),
  iron: svg(
    '<path fill="#424d55" d="m7 45 8-19 20-5 15 12 8 20-24 7Z"/><path fill="#9ca7aa" d="m15 26 20-5 4 15-18 7Z"/><path fill="#68747d" d="m39 36 11-3 8 20-24 7Z"/><path fill="#c3ced0" stroke="none" d="m18 29 13-3-9 9Z"/>',
  ),
  horses: svg(
    '<path fill="#a27848" d="m7 31 15-8 21 4 6-17 8-2 4 10-10 9-3 13-8 3-3 15h-5l1-17-13-3-4 20h-5l2-24Z"/><path stroke="#3e3025" stroke-width="3" d="m43 25 4-15 8-4 M9 29 4 47"/><circle fill="#eee3c9" cx="56" cy="15" r="1.4"/>',
  ),
  gems: svg(
    '<path fill="#4ac4bd" d="m7 29 11-13 21 2 8 13-21 26Z"/><path fill="#a2eee0" d="m7 29 19-4-8-9 21 2-13 7 21 6Z"/><path fill="#267f9a" d="m26 25 21 6-21 26Z"/><path fill="#a688cf" d="m38 15 9-8 12 9-8 15Z"/><path fill="#edd4f3" d="m38 15 9-8 4 10 8-1-8 15Z"/>',
  ),
  wines: svg(
    '<path stroke="#6f8141" stroke-width="3" d="m31 15 8-10 M32 16l-13-6"/><path fill="#7d9949" d="m33 14-8-9-13 2 7 12Z"/><g fill="#694777"><circle cx="23" cy="25" r="8"/><circle cx="38" cy="24" r="8"/><circle cx="16" cy="37" r="8"/><circle cx="31" cy="37" r="8"/><circle cx="45" cy="36" r="8"/><circle cx="24" cy="49" r="8"/><circle cx="38" cy="48" r="8"/><circle cx="31" cy="58" r="6"/></g>',
  ),
  wheat: svg(
    '<path fill="none" stroke="#dec05d" stroke-width="3" d="m18 58 9-41 M33 58l-1-47 M42 58l7-41"/><g fill="#edd17e"><path d="m27 17-8 4 1 9 6-3 8-8-7-6Z M25 32l-9-3 1 10 7 3 9-8-1-8Z M32 11l-8 5 2 9 6 4 8-11-4-8Z M32 32l-8-5-1 10 10 8 8-11-2-8Z M49 17l-9 4 2 9 6-3 8-7-2-8Z M47 32l-8-4-2 11 9 5 9-10-1-7Z"/></g>',
  ),
  fish: svg(
    '<path fill="#86b8c4" d="M7 31Q25 6 48 24l12-12-2 33-13-7Q22 57 7 31Z"/><path fill="#bed7ce" stroke="none" d="M10 32q18 4 36-4-10 17-27 12Z"/><path fill="#5f8c9e" d="m24 17 9-9 8 13 M26 43l10 9 7-13"/><circle fill="#253b43" cx="17" cy="29" r="3"/>',
  ),
  'city-village': svg(
    '<ellipse stroke="none" fill="#1b2b20" opacity=".35" cx="32" cy="52" rx="30" ry="9"/>' +
      house(5, 16, 0.8) +
      house(32, 10, 0.85) +
      house(19, 29),
  ),
  'city-town': svg(
    '<ellipse stroke="none" fill="#1b2b20" opacity=".35" cx="32" cy="52" rx="31" ry="10"/>' +
      house(3, 10, 0.75) +
      house(36, 8, 0.8) +
      house(13, 15) +
      house(34, 30, 0.8) +
      house(1, 33, 0.8) +
      '<path fill="#dbc9a0" d="M30 15 36 12 42 15v26l-12 4Z"/><path fill="#916049" d="m28 15 8-12 8 12-8 4Z"/>',
  ),
  'city-capital': svg(
    '<ellipse stroke="none" fill="#1b2b20" opacity=".35" cx="32" cy="53" rx="31" ry="10"/>' +
      house(1, 8, 0.75) +
      house(40, 6, 0.75) +
      '<path fill="#d5c39a" d="M18 17 32 12 47 18v28l-15 7-14-6Z"/><path fill="#948778" d="m18 17 14-5 15 6-15 6Z"/><path fill="#615749" d="M26 35h10v17H26Z"/><path fill="#e1d2b3" d="M12 9h10v38H12Z M43 10h10v34H43Z"/><path fill="#965443" d="m10 10 7-10 7 10Z m31 1 7-10 7 10Z"/>' +
      house(2, 34, 0.7) +
      house(43, 32, 0.7),
  ),
};

export type MapSprites = Readonly<Partial<Record<string, CanvasImageSource>>>;

export const loadMapSprites = async (): Promise<MapSprites> =>
  Object.fromEntries(
    await Promise.all(
      Object.entries(MAP_ART).map(async ([id, source]) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
        await image.decode();
        return [id, image] as const;
      }),
    ),
  );
