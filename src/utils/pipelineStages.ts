import { migrateLegacyPieceStatus, type PipelineStage, type StageSystemKey } from '../types';

/**
 * Which configured stage a piece (or a history entry) is in.
 *
 * By stage id first (0045). A row without one — cached before 0045, or a
 * stages list that has not caught up yet — falls back to its stored name, and
 * then to the name a retired stage maps onto (migrateLegacyPieceStatus), the
 * same normalisation every name-based reader applies today.
 */
export function stageOf(
  piece: { stageId?: string | null; status?: string | null },
  stages: PipelineStage[]
): PipelineStage | undefined {
  if (piece.stageId) {
    const byId = stages.find(stage => stage.id === piece.stageId);
    if (byId) return byId;
  }
  const name = piece.status || '';
  return stages.find(stage => stage.name === name)
    ?? stages.find(stage => stage.name === migrateLegacyPieceStatus(name));
}

/** The system stage with this key, or undefined if it is missing from the list. */
export function stageByKey(stages: PipelineStage[], key: StageSystemKey): PipelineStage | undefined {
  return stages.find(stage => stage.systemKey === key);
}

/**
 * Collected and Broken: outcomes a piece leaves the board through, not queues
 * it waits in. A custom stage is never an end-state.
 */
export function isEndState(stage: PipelineStage | undefined): boolean {
  return stage?.systemKey === 'collected' || stage?.systemKey === 'broken';
}
