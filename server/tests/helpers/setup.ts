// Must be the FIRST import in every test file — loads .env before any
// module (e.g. src/db/prisma) reads process.env at module-evaluation time.
import "../../src/config/load-env";
