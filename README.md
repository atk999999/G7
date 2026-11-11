# PK LOẠN CHIẾN — AI Studio 0.1.33

Chuyển nguyên bản game HTML offline `LoanChien_0_1_32_AutoTarget900_TrackingNhe_OFFLINE.html` sang **React 19 + Vite + TypeScript**, dùng cho **Google AI Studio Build**.

## Sử dụng

1. Giải nén toàn bộ project, đưa source vào dự án Google AI Studio (hoặc đưa lên GitHub và nạp source). Không chỉ sao chép `index.html`: cần cả `src/`, `public/`, `package.json`, `vite.config.ts`.
2. Nếu chạy trên PC: `npm install`, sau đó `npm run dev`.
3. Build: `npm run build` → `dist/` là web tĩnh, không cần API key hay máy chủ backend.

## Chỉnh sửa game bằng AI Studio

- `src/App.tsx` — JSX giao diện chính, bảng Cài đặt / Giới thiệu / thanh HP-MP / nút cảm ứng.
- `src/game/game.css` — mọi kiểu hiển thị, joystick, giao diện dọc/ngang.
- `src/game/engine.js` — **logic nguyên bản**: Diệp Tu, 17 bộ hoạt ảnh, va chạm, địa tầng, Hỏa Cầu, tìm mục tiêu 900 đơn vị, đạn truy đuổi 70°/giây và âm thanh.
- `src/game/pixelfx.js` — thư viện PixelFX v0.3.0 và hiệu ứng gốc, **không thay kỹ năng bằng Canvas tự vẽ**.
- `public/assets/sprites/` — 17 dải WebP của Diệp Tu gốc (20 sprite keys bao gồm các khung tăng cường), giữ nguyên nhịp.
- `public/assets/backgrounds/` — 3 phông nền WebP.

> Quan trọng: Khi nâng cấp kỹ năng, tiếp tục dùng PixelFX. Giữ Diệp Tu WebP gốc và cập nhật mục Giới thiệu phiên bản trong `src/App.tsx` mỗi lần sửa.

## Lưu ý

- Nguồn HTML gốc nhúng ảnh dạng Base64. Bản AI Studio tách ảnh thành WebP thực để chỉnh sửa/đổi nhân vật dễ hơn; không thay đổi dữ liệu hình ảnh.
- Engine được nạp **sau khi** React dựng giao diện; không bật React `StrictMode` vì engine quản lý animation loop.
- Asset là đường dẫn tương đối nên deploy vào thư mục con (GitHub Pages) được. Ảnh tải từ chính bản build, không cần Internet sau khi tải trang.
- Đây là dự án React/Vite thực sự, không phải iframe bao HTML gốc.
