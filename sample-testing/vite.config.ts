export default {
  server: {
    fs: {
      allow: ['..'],
    },
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  optimizeDeps: {
    // Stops Vite from automatically scanning and pre-bundling node_modules
    noDiscovery: true,
    // Leaves the explicit include list empty
    include: [],
  },
};
