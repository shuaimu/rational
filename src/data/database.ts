import { createRxDatabase, type RxCollection, type RxDatabase, removeRxDatabase } from "rxdb";
import { getRxStorageDexie } from "rxdb/plugins/storage-dexie";

import { rxdbSchema } from "../model/collections.js";
import type { CollectionId, RationalDocuments } from "../model/types.js";
import { conflictHandler } from "./conflict.js";

export type RationalCollections<Ids extends CollectionId> = {
  [Id in Ids]: RxCollection<RationalDocuments[Id]>;
};

export type RationalDatabase<Ids extends CollectionId> = RxDatabase<RationalCollections<Ids>>;

/**
 * RxDB's codes for "what is on the device cannot be opened by this build":
 * `DB6`, a collection stored under a different schema at the same local
 * version, and `DM5`, database state written by an older RxDB major.
 */
export const STORED_STATE_INCOMPATIBLE_CODES: readonly string[] = ["DB6", "DM5"];

export function isStoredStateIncompatible(error: unknown): boolean {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" && STORED_STATE_INCOMPATIBLE_CODES.includes(code);
}

/**
 * An RxDB database on Dexie (IndexedDB) with one collection per document
 * type, every collection sharing the deterministic conflict handler. The
 * storage is durable, which is the point: a reload or an offline restart
 * finds the household's data where it left it.
 */
export async function openDatabase<Ids extends CollectionId>(
  name: string,
  collectionIds: readonly Ids[],
): Promise<RationalDatabase<Ids>> {
  try {
    return await createAndAddCollections(name, collectionIds);
  } catch (error) {
    // A device that stored the model under an older schema cannot open the
    // new one -- RxDB refuses a changed schema at the same local version, and
    // it is right to; state written by an older RxDB major is refused the
    // same way. Rational's answer is the local-first one: the device's copy
    // is a replica of the server's, so erase it and pull it again. What is
    // lost is only unsynced local edits from the moment of upgrade, which is
    // the honest trade of shipping a new model to a static site without
    // per-version migration code.
    //
    // Only those two failures say the stored data is unusable. Anything else
    // -- the free build's cap on open collections (COL23), a name still open
    // elsewhere (DB8), a storage or quota failure -- says nothing about the
    // data, and erasing on it would destroy edits that never left the
    // device. Those are raised to the caller, who keeps the data and says so.
    if (!isStoredStateIncompatible(error)) throw error;
    console.warn(`local database ${name} predates the current model; rebuilding`, error);
    await removeRxDatabase(name, getRxStorageDexie());
    return await createAndAddCollections(name, collectionIds);
  }
}

async function createAndAddCollections<Ids extends CollectionId>(
  name: string,
  collectionIds: readonly Ids[],
): Promise<RationalDatabase<Ids>> {
  const database = await createRxDatabase<RationalCollections<Ids>>({
    name,
    storage: getRxStorageDexie(),
    multiInstance: false,
    eventReduce: true,
  });
  const definitions = Object.fromEntries(
    collectionIds.map((id) => [id, { schema: rxdbSchema(id), conflictHandler: conflictHandler() }]),
  );
  // RxDB types the creators against every collection of the database type;
  // this database holds exactly the ids it was asked for.
  try {
    await database.addCollections(definitions as never);
  } catch (error) {
    // Close before the caller retries with a fresh store, or Dexie holds the
    // connection open and the erase deadlocks.
    await database.close().catch(() => undefined);
    throw error;
  }
  return database;
}

/**
 * Erase a database that is not open. A security reset that arrives while the
 * scope holds no session — the epochs moved between two visits — still has to
 * clear what the previous generation left on the device.
 */
export async function removeDatabase(name: string): Promise<void> {
  await removeRxDatabase(name, getRxStorageDexie());
}
