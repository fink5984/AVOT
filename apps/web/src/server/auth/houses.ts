import "server-only";
import { forbidden } from "../errors";

/**
 * Auction-house scoping. It separates commercial data (catalogs, lots,
 * descriptions) and the interface — never the inventory itself, which is shared.
 */
export interface HouseScoped {
  houseIds: string[] | null;
}

export function canSeeHouse(user: HouseScoped, houseId: string): boolean {
  return user.houseIds === null || user.houseIds.includes(houseId);
}

export function assertHouse(user: HouseScoped, houseId: string) {
  if (!canSeeHouse(user, houseId)) throw forbidden();
}

/** Prisma `where` fragment for Catalog rows the user may see. */
export function catalogScope(user: HouseScoped): { auctionHouseId?: { in: string[] } } {
  return user.houseIds === null ? {} : { auctionHouseId: { in: user.houseIds } };
}
