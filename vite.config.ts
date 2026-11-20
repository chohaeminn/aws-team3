import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 화면 소스는 src/web, 빌드 결과는 dist/web에 만들고 Express가 제공한다.
export default defineConfig({
  root: "src/web",
  plugins: [react()],
  // 프로젝트 밖(상위 폴더)의 postcss.config.js를 찾아 읽지 않도록 빈 설정을 지정한다.
  css: { postcss: {} },
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
  },
});
