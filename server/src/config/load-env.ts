try {
  process.loadEnvFile();
} catch {
  // .env is optional; fall back to existing process.env / defaults
}
