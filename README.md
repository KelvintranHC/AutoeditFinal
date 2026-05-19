<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/ea84861c-1494-4829-b419-ce60756b65b9

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Downloader / Merge

- **Đồng bộ Drive cache** (`/api/drive/resync-scene-videos`): chỉ đọc lại Firestore `videoDownloads`, không tải lại file.
- **Upload lại folder đích** (`POST /api/downloader/reupload-drive-batch`): tải từng clip qua **link Direct (HTTP)**, upload bản mới vào folder **Target destination**; clip đã có parent = folder đích thì **bỏ qua** (tránh trùng); cập nhật link view/direct + Firestore. Payload `clips` từ timeline khi cần.
