/**
 * Nominal (branded) identifiers.
 *
 * Every entity id is structurally a number/string but nominally distinct, so a
 * `CityId` can never be passed where a `UnitId` is expected. See PLAN.md 4.2.
 */

declare const brand: unique symbol;

export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type PlayerId = Brand<number, 'PlayerId'>;
export type UnitId = Brand<number, 'UnitId'>;
export type CityId = Brand<number, 'CityId'>;
export type TileIndex = Brand<number, 'TileIndex'>; // y * width + x, row-major
export type TechId = Brand<string, 'TechId'>;
export type GovernmentId = Brand<string, 'GovernmentId'>;
export type TerrainId = Brand<string, 'TerrainId'>;
export type UnitTypeId = Brand<string, 'UnitTypeId'>;
export type BuildingId = Brand<string, 'BuildingId'>;
export type ResourceId = Brand<string, 'ResourceId'>;

export const asPlayerId = (n: number): PlayerId => n as PlayerId;
export const asUnitId = (n: number): UnitId => n as UnitId;
export const asCityId = (n: number): CityId => n as CityId;
export const asTileIndex = (n: number): TileIndex => n as TileIndex;
export const asTechId = (s: string): TechId => s as TechId;
export const asGovernmentId = (s: string): GovernmentId => s as GovernmentId;
export const asTerrainId = (s: string): TerrainId => s as TerrainId;
export const asUnitTypeId = (s: string): UnitTypeId => s as UnitTypeId;
export const asBuildingId = (s: string): BuildingId => s as BuildingId;
export const asResourceId = (s: string): ResourceId => s as ResourceId;
