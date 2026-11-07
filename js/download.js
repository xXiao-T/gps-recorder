/**
 * 文件下载与 Web Share。
 * Android Chrome 优先走系统分享面板，不支持时回退下载。
 */

export function downloadFile({ text, mime, filename }) {
  const blob = new Blob([text], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 部分 Android 浏览器需要延迟释放
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * 分享文件；用户取消分享时不自动下载。
 * @returns {Promise<'shared'|'cancelled'|'downloaded'>}
 */
export async function shareOrDownload(file) {
  const canUseFileShare =
    typeof File !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function';

  if (canUseFileShare) {
    const blob = new Blob([file.text], { type: file.mime });
    const shareFile = new File([blob], file.filename, { type: file.mime });
    try {
      if (navigator.canShare({ files: [shareFile] })) {
        await navigator.share({ files: [shareFile], title: file.filename });
        return 'shared';
      }
    } catch (error) {
      if (error?.name === 'AbortError') return 'cancelled';
      // 其他错误（系统无分享目标等）回退到下载
    }
  }

  downloadFile(file);
  return 'downloaded';
}

/** 下载 JSON（备份用）。 */
export function downloadJson(value, filename) {
  downloadFile({
    text: JSON.stringify(value, null, 2),
    mime: 'application/json;charset=utf-8',
    filename,
  });
}
