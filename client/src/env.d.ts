/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module '*.png' {
  const src: string
  export default src
}


declare module 'libarchive.js/dist/libarchive.js' {
  export const Archive: any
  export const ArchiveCompression: any
  export const ArchiveFormat: any
}
