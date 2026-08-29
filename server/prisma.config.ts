import { defineConfig } from "prisma/config";
import "./src/config/load-env";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
