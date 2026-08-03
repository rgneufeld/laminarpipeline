import { supabase } from './supabase-client.js';

async function invokeArtifactUpload(payload) {
  const { data, error } = await supabase.functions.invoke('artifact-upload', { body: payload });
  if (error) {
    let message = error.message;
    if (error.context instanceof Response) {
      try {
        const body = await error.context.clone().json();
        if (typeof body?.error === 'string') message = body.error;
      } catch { /* retain the transport error when the body is not JSON */ }
    }
    throw new Error(message);
  }
  if (data?.error) throw new Error(data.error);
  return data;
}

export async function uploadProjectArtifact({ projectId, file, title, visibility, artifactId = null }) {
  if (!(file instanceof File)) throw new Error('Choose a document to upload.');
  const prepared = await invokeArtifactUpload({
    action: 'prepare', projectId, artifactId, title: title || file.name,
    visibility, fileName: file.name, mimeType: file.type, byteSize: file.size,
  });
  const { error: uploadError } = await supabase.storage.from('artifacts').uploadToSignedUrl(prepared.storagePath, prepared.token, file, { contentType: file.type || 'application/octet-stream' });
  if (uploadError) throw new Error(uploadError.message);
  await invokeArtifactUpload({ action: 'complete', projectId, versionId: prepared.versionId });
  return prepared.artifactId;
}

export async function artifactDownloadUrl({ projectId, artifactId }) {
  const data = await invokeArtifactUpload({ action: 'download', projectId, artifactId });
  return data.url;
}

export async function publishClientArtifactCopy({ projectId, artifactId }) {
  return invokeArtifactUpload({ action: 'publish-client-copy', projectId, artifactId });
}
