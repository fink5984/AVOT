export interface JobDto {
  id: string;
  status: string;
  progress: number;
  progressTotal: number;
  resultName: string | null;
  resultBytes: number | null;
  downloadable: boolean;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  expiresAt: string | null;
  payload: unknown;
}

export function jobDto(j: {
  id: string;
  status: string;
  progress: number;
  progressTotal: number;
  resultName: string | null;
  resultBytes: bigint | null;
  resultKey: string | null;
  error: string | null;
  createdAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
  payload: unknown;
}): JobDto {
  return {
    id: j.id,
    status: j.status,
    progress: j.progress,
    progressTotal: j.progressTotal,
    resultName: j.resultName,
    resultBytes: j.resultBytes ? Number(j.resultBytes) : null,
    downloadable: j.status === "SUCCEEDED" && !!j.resultKey && (!j.expiresAt || j.expiresAt > new Date()),
    error: j.error,
    createdAt: j.createdAt.toISOString(),
    finishedAt: j.finishedAt?.toISOString() ?? null,
    expiresAt: j.expiresAt?.toISOString() ?? null,
    payload: j.payload,
  };
}
