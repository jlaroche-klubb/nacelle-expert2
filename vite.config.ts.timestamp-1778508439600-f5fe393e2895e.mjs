// vite.config.ts
import { defineConfig } from "file:///home/jlaroche-klubb/nacelle-expert2/node_modules/vite/dist/node/index.js";
import react from "file:///home/jlaroche-klubb/nacelle-expert2/node_modules/@vitejs/plugin-react/dist/index.js";
var vite_config_default = defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ["firebase/app", "firebase/firestore"]
  },
  server: {
    proxy: {
      "/api": {
        target: "https://api.anthropic.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/analyze/, "/v1/messages"),
        headers: {
          "x-api-key": process.env.VITE_ANTHROPIC_KEY || "",
          "anthropic-version": "2023-06-01"
        }
      }
    }
  }
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9qbGFyb2NoZS1rbHViYi9uYWNlbGxlLWV4cGVydDJcIjtjb25zdCBfX3ZpdGVfaW5qZWN0ZWRfb3JpZ2luYWxfZmlsZW5hbWUgPSBcIi9ob21lL2psYXJvY2hlLWtsdWJiL25hY2VsbGUtZXhwZXJ0Mi92aXRlLmNvbmZpZy50c1wiO2NvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9pbXBvcnRfbWV0YV91cmwgPSBcImZpbGU6Ly8vaG9tZS9qbGFyb2NoZS1rbHViYi9uYWNlbGxlLWV4cGVydDIvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcgfSBmcm9tICd2aXRlJ1xuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xuXG5leHBvcnQgZGVmYXVsdCBkZWZpbmVDb25maWcoe1xuICBwbHVnaW5zOiBbcmVhY3QoKV0sXG4gIG9wdGltaXplRGVwczoge1xuICAgIGluY2x1ZGU6IFsnZmlyZWJhc2UvYXBwJywgJ2ZpcmViYXNlL2ZpcmVzdG9yZSddXG4gIH0sXG4gIHNlcnZlcjoge1xuICAgIHByb3h5OiB7XG4gICAgICAnL2FwaSc6IHtcbiAgICAgICAgdGFyZ2V0OiAnaHR0cHM6Ly9hcGkuYW50aHJvcGljLmNvbScsXG4gICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZSxcbiAgICAgICAgcmV3cml0ZTogKHBhdGgpID0+IHBhdGgucmVwbGFjZSgvXlxcL2FwaVxcL2FuYWx5emUvLCAnL3YxL21lc3NhZ2VzJyksXG4gICAgICAgIGhlYWRlcnM6IHtcbiAgICAgICAgICAneC1hcGkta2V5JzogcHJvY2Vzcy5lbnYuVklURV9BTlRIUk9QSUNfS0VZIHx8ICcnLFxuICAgICAgICAgICdhbnRocm9waWMtdmVyc2lvbic6ICcyMDIzLTA2LTAxJ1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuICB9XG59KSJdLAogICJtYXBwaW5ncyI6ICI7QUFBOFIsU0FBUyxvQkFBb0I7QUFDM1QsT0FBTyxXQUFXO0FBRWxCLElBQU8sc0JBQVEsYUFBYTtBQUFBLEVBQzFCLFNBQVMsQ0FBQyxNQUFNLENBQUM7QUFBQSxFQUNqQixjQUFjO0FBQUEsSUFDWixTQUFTLENBQUMsZ0JBQWdCLG9CQUFvQjtBQUFBLEVBQ2hEO0FBQUEsRUFDQSxRQUFRO0FBQUEsSUFDTixPQUFPO0FBQUEsTUFDTCxRQUFRO0FBQUEsUUFDTixRQUFRO0FBQUEsUUFDUixjQUFjO0FBQUEsUUFDZCxTQUFTLENBQUMsU0FBUyxLQUFLLFFBQVEsbUJBQW1CLGNBQWM7QUFBQSxRQUNqRSxTQUFTO0FBQUEsVUFDUCxhQUFhLFFBQVEsSUFBSSxzQkFBc0I7QUFBQSxVQUMvQyxxQkFBcUI7QUFBQSxRQUN2QjtBQUFBLE1BQ0Y7QUFBQSxJQUNGO0FBQUEsRUFDRjtBQUNGLENBQUM7IiwKICAibmFtZXMiOiBbXQp9Cg==
