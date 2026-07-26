// 대시보드(web/) 빌드 설정. 산출물은 dist/ — 데몬이 그대로 서빙한다.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    // yarn dev 개발용: API/WS는 로컬 데몬(9200)으로 프록시
    proxy: {
      '/api': 'http://127.0.0.1:9200',
      '/ws': { target: 'ws://127.0.0.1:9200', ws: true },
    },
  },
});
