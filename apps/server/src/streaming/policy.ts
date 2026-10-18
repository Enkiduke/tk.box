import type { Quality } from '../../../../packages/contracts/src/index.js';
import { AppError, requireThat } from '../errors.js';

export type SourceVideo = { codec: string; width?: number; height?: number; container: string; audioCodec?: string; bitDepth?: number };
export type ClientCapabilities = { videoCodecs: string[]; audioCodecs: string[]; containers: string[] };
export type Route = { kind: 'direct' | 'remux' | 'cpu'; maxHeight?: number; audioEncode: boolean };
export function eligibleVideoEncode(s: SourceVideo) {
  const dims = [s.width, s.height];
  return dims.every(d => d !== undefined && Number.isInteger(d) && d > 0) && Math.max(s.width!, s.height!) <= 1920 && Math.min(s.width!, s.height!) <= 1080;
}
export function assertVideoEncode(s: SourceVideo) {
  requireThat(eligibleVideoEncode(s) && !!s.codec, 'QUALITY_NOT_PERMITTED', 'Video encoding requires verified 1080p-or-lower source video. 4K HEVC encoding is forbidden.', 422);
}
export function chooseRoute(source: SourceVideo, client: ClientCapabilities, quality: Quality = 'auto', protectedCopyApproved = false, directAllowed = true): Route {
  const ceiling = quality === '720p' ? 720 : quality === '1080p' ? 1080 : undefined;
  const videoCompatible = client.videoCodecs.includes(`${source.codec}:${source.bitDepth ?? 8}`);
  const audioCompatible = !source.audioCodec || client.audioCodecs.includes(source.audioCodec);
  const knownDimensions = [source.width, source.height].every(v => v !== undefined && Number.isSafeInteger(v) && v > 0);
  const needsScale = ceiling !== undefined && (!knownDimensions || Math.min(source.width!, source.height!) > ceiling);
  if (directAllowed && videoCompatible && audioCompatible && client.containers.includes(source.container) && !needsScale) return { kind: 'direct', audioEncode: false };
  if (videoCompatible && !needsScale) {
    const protectedVideo = source.codec === 'hevc' && (!source.width || !source.height || Math.max(source.width, source.height) > 1920 || Math.min(source.width, source.height) > 1080);
    requireThat(!protectedVideo || protectedCopyApproved, 'QUALITY_NOT_PERMITTED', '4K HEVC remux/audio conversion requires verified hosting permission.', 422);
    requireThat(client.containers.includes('hls'), 'SOURCE_INCOMPATIBLE', 'Client cannot play the available remux output.', 422);
    return {kind: 'remux', audioEncode: !audioCompatible};
  }
  if (quality === 'original') throw new AppError('SOURCE_INCOMPATIBLE', 'Original is unavailable for this client without video encoding.', 422);
  assertVideoEncode(source);
  requireThat(client.videoCodecs.includes('h264:8') && client.audioCodecs.includes('aac') && client.containers.includes('hls'), 'SOURCE_INCOMPATIBLE', 'Client cannot play the CPU output profile.', 422);
  return {kind: 'cpu', ...(ceiling ? {maxHeight: ceiling} : {}), audioEncode: true};
}
export class EncoderBudget {
  private active = new Set<string>();
  constructor(private getLimit: () => number) {}
  reserve(pipelineId: string) {
    requireThat(!this.active.has(pipelineId), 'DUPLICATE_PIPELINE', 'Encoder is already reserved.', 409);
    if (this.active.size >= this.getLimit()) throw new AppError('TRANSCODE_CAPACITY_REACHED', 'Transcoding capacity reached. Please try again.', 503, true);
    // Synchronous admission in the single Node process, before any asynchronous startup.
    this.active.add(pipelineId); let released = false;
    return () => { if (!released) { this.active.delete(pipelineId); released = true; } };
  }
  get count() { return this.active.size; }
}
