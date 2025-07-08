// lib/uploadViaTUS.ts
import * as tus from "tus-js-client"

interface TUSOptions {
  file: File
  bucket: string // "wedding"
  objectPath: string // e.g. `${uid}/${uuid}-${file.name}`
  accessToken: string
  onProgress: (pct: number) => void
}

export function uploadViaTUS({
  file,
  bucket,
  objectPath,
  accessToken,
  onProgress,
}: TUSOptions): Promise<void> {
  const endpoint = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`

  return new Promise((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint,
      chunkSize: 6 * 1024 * 1024, // Supabase requirement
      retryDelays: [0, 3000, 5000, 10000, 20000],
      removeFingerprintOnSuccess: true,
      uploadDataDuringCreation: true,

      headers: {
        authorization: `Bearer ${accessToken}`,
        "x-upsert": "true",
      },
      metadata: {
        bucketName: bucket,
        objectName: objectPath,
        contentType: file.type,
        cacheControl: "3600",
      },

      onError: reject,
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = Math.round((bytesUploaded / bytesTotal) * 100)
        onProgress(pct)
      },
      onSuccess: () => resolve(),
    })

    upload.findPreviousUploads().then((prev) => {
      if (prev.length) upload.resumeFromPreviousUpload(prev[0])
      upload.start()
    })
  })
}
