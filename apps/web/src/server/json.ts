import type { Prisma } from "@prisma/client";

/** Narrow cast for typed objects stored in Json columns. */
export const asJson = (value: unknown) => value as Prisma.InputJsonValue;
