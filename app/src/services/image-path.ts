export function isImagePath(path: string) {
  return /\.(png|jpe?g|jfif|gif|webp|svg|bmp|ico|avif)$/i.test(path);
}
