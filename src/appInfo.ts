/**
 * Thông tin phiên bản AutoEdit — cập nhật mỗi lần release.
 * - Tăng APP_VERSION lên 1
 * - Đặt APP_UPDATE_DATE theo ngày phát hành (YYYY-MM-DD)
 */
export const APP_NAME = "AutoEdit";
export const APP_VERSION = 1;
/** Ngày cập nhật phiên bản hiện tại (ISO: YYYY-MM-DD) */
export const APP_UPDATE_DATE = "2026-05-16";

export function formatAppUpdateDate(isoDate = APP_UPDATE_DATE): string {
  const [y, m, d] = isoDate.split("-");
  if (!y || !m || !d) return isoDate;
  return `${d}/${m}/${y}`;
}

export function getAppVersionTitle(): string {
  return `${APP_NAME}_Ver ${APP_VERSION}`;
}

export function getAppUpdateLabel(): string {
  return `Ngày cập nhật: ${formatAppUpdateDate()}`;
}

export function getAppFullLabel(): string {
  return `${getAppVersionTitle()} · ${getAppUpdateLabel()}`;
}
