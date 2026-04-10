export async function fileToImageBitmap(file) {
  return await createImageBitmap(file);
}

export async function resizeToJpegBytes(bitmap, maxW, quality=0.82) {
  const scale = Math.min(1, maxW / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, w, h);

  const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
  const buf = await blob.arrayBuffer();
  return { bytes: new Uint8Array(buf), w, h };
}

export function bytesToObjectUrl(bytes, mime="image/jpeg") {
  const blob = new Blob([bytes], { type: mime });
  return URL.createObjectURL(blob);
}
