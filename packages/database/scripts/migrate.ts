import { migrate, pool } from "../src/index.ts";

try {
  await migrate();
} finally {
  await pool.end();
}
