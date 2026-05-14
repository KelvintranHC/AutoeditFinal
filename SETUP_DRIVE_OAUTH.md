# Setup Google Drive OAuth (No Firebase)

App này dùng OAuth 2.0 trực tiếp với Google. Bạn chỉ cần 1 lần setup ~5 phút,
sau đó app tự quản lý token (refresh tự động vĩnh viễn).

## 1. Tạo OAuth Client trong Google Cloud Console

1. Mở https://console.cloud.google.com/ → đăng nhập bằng Google account
   bạn muốn upload video.
2. Tạo project mới (top bar → **NEW PROJECT**) — đặt tên gì cũng được, vd
   `finalauto-local`. Chọn project vừa tạo.
3. Vào menu **APIs & Services → Library** → tìm **Google Drive API** → bấm
   **Enable**.
4. Vào **APIs & Services → OAuth consent screen**:
   - User type: **External** → Create
   - App name: `FinalAuto Local`
   - User support email + Developer contact: email của bạn
   - **Save and continue**
   - Bước Scopes: bấm **Add or remove scopes** → tìm
     `.../auth/drive.file` → tick → Update → Save and continue.
   - Bước Test users: **Add users** → email Google của bạn → Save.
   - Finish.
5. Vào **APIs & Services → Credentials** → **+ CREATE CREDENTIALS** →
   **OAuth client ID**:
   - Application type: **Web application**
   - Name: `FinalAuto Local`
   - **Authorized JavaScript origins**: `http://localhost:3001`
   - **Authorized redirect URIs**: `http://localhost:3001/api/auth/google/callback`
   - **Create**
6. Một popup hiện ra với **Client ID** và **Client secret** — copy cả hai.

## 2. Cập nhật `.env.local`

```env
PORT=3001
GOOGLE_OAUTH_CLIENT_ID=<paste Client ID ở đây>
GOOGLE_OAUTH_CLIENT_SECRET=<paste Client secret ở đây>
```

## 3. Restart server

```bash
npm run dev
```

## 4. Connect Drive trong app

1. Mở http://localhost:3001
2. Mở Project → tab **Auth Cookies**
3. Bấm **Connect Provider** → popup Google → chọn account → **Allow**
4. Popup tự đóng, status chuyển **Connection established and ready**.
5. Dán link folder Drive vào ô **Target Destination Folder Link**.

## Token được lưu ở đâu?

File `.drive-token.json` (gitignored) tại root project. Để **logout/disconnect**:

```bash
rm .drive-token.json
```

hoặc gọi:

```bash
curl -X POST http://localhost:3001/api/auth/google/logout
```

## Khi nào cần Connect lại?

- Khi bạn revoke quyền tại https://myaccount.google.com/permissions
- Khi bạn xóa file `.drive-token.json`
- Khi đổi `GOOGLE_OAUTH_CLIENT_ID`

Còn lại app tự refresh token mãi mãi, không bao giờ cần login lại.

## Lưu ý quan trọng

- Scope chỉ là `drive.file` → app **chỉ thấy được file/folder mà nó tạo
  ra hoặc bạn explicit chọn**, không truy cập được toàn bộ Drive của bạn.
  An toàn cho privacy.
- OAuth client đang ở chế độ **Testing** chỉ cho phép tối đa 100 user
  trong "Test users". Đủ dùng local. Nếu muốn publish: chuyển App
  publishing status → Production (cần Google verify nếu dùng scope nhạy
  cảm — `drive.file` không cần verify).
