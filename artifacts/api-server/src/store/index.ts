import type { Store } from "./storeContract";
import { MemoryStore } from "./memoryStore";
import { PostgresStore } from "./postgresStore";

/**
 * Storage entry point. PostgreSQL activation is explicit so an untested
 * adapter can never be selected merely because a DATABASE_URL exists.
 */
const usePostgresStore = process.env.TEZJET_STORAGE_ADAPTER === "postgres";

if (process.env.NODE_ENV === "production" && !usePostgresStore) {
  throw new Error("Set TEZJET_STORAGE_ADAPTER=postgres in production; refusing to start with in-memory storage");
}
if (usePostgresStore && !process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required when TEZJET_STORAGE_ADAPTER=postgres");
}

export const store: Store = usePostgresStore ? new PostgresStore() : new MemoryStore();
