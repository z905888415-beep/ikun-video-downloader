export async function downloadImagesAsZip(urls: string[], onProgress: (p: number) => void): Promise<Blob> {
  const zip = new (await import('jszip')).default()
  for (let i = 0; i < urls.length; i++) {
    const res = await fetch(urls[i])
    if (res.ok) zip.file(`image-${i + 1}.jpg`, await res.blob())
    onProgress(Math.round(((i + 1) / urls.length) * 100))
  }
  return zip.generateAsync({ type: 'blob' })
}
