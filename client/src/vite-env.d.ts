/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the SwiftDrop backend API, e.g. http://localhost:3000/api/v1 */
  readonly VITE_API_BASE_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
