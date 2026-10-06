export interface WeightedQueueParticipant {
  id: string;
  queue_position: number | null;
  queue_weight: number;
  queue_credit: number;
}

export interface WeightedQueueSelection<T extends WeightedQueueParticipant> {
  selected: T;
  credits: Map<string, number>;
  totalWeight: number;
}

export function compactQueuePositions<
  T extends Pick<WeightedQueueParticipant, 'id' | 'queue_position'>,
>(participants: T[], lastPosition: number) {
  const ordered = participants
    .filter((participant) => participant.queue_position !== null)
    .sort((a, b) => a.queue_position! - b.queue_position! || a.id.localeCompare(b.id));
  return {
    positions: new Map(ordered.map((participant, index) => [participant.id, index + 1])),
    lastPosition: ordered.filter((participant) => participant.queue_position! <= lastPosition)
      .length,
  };
}

const orderedAfter = <T extends WeightedQueueParticipant>(users: T[], lastPosition: number) =>
  [...users].sort(
    (a, b) =>
      (a.queue_position! > lastPosition ? 0 : 1) - (b.queue_position! > lastPosition ? 0 : 1) ||
      a.queue_position! - b.queue_position! ||
      a.id.localeCompare(b.id),
  );

export function selectWeightedParticipant<T extends WeightedQueueParticipant>(
  participants: T[],
  lastPosition: number,
): WeightedQueueSelection<T> | undefined {
  const eligible = participants.filter(
    (participant) =>
      participant.queue_position !== null &&
      Number.isInteger(participant.queue_weight) &&
      participant.queue_weight >= 1 &&
      participant.queue_weight <= 5,
  );
  if (!eligible.length) return;

  const totalWeight = eligible.reduce((sum, participant) => sum + participant.queue_weight, 0);
  // queue_credit stores how many consecutive reservations are still owed to the
  // participant at lastPosition. Values are clamped so deployments made while the
  // former smooth-weight algorithm was active cannot create an oversized block.
  const credits = new Map(eligible.map((participant) => [participant.id, 0]));
  const current = eligible.find((participant) => participant.queue_position === lastPosition);
  const remaining = current
    ? Math.min(Math.max(Math.trunc(current.queue_credit), 0), current.queue_weight - 1)
    : 0;
  if (current && remaining > 0) {
    credits.set(current.id, remaining - 1);
    return { selected: current, credits, totalWeight };
  }

  const selected = orderedAfter(eligible, lastPosition)[0];
  credits.set(selected.id, selected.queue_weight - 1);
  return { selected, credits, totalWeight };
}

export function previewWeightedOrder<T extends WeightedQueueParticipant>(
  participants: T[],
  lastPosition: number,
) {
  const eligible = participants.filter((participant) => participant.queue_position !== null);
  const simulated = eligible.map((participant) => ({ ...participant }));
  const order: string[] = [];
  let cursor = lastPosition;
  const limit = eligible.reduce((sum, participant) => sum + participant.queue_weight, 0);

  for (let step = 0; step < limit && order.length < eligible.length; step++) {
    const selection = selectWeightedParticipant(simulated, cursor);
    if (!selection) break;
    for (const participant of simulated)
      participant.queue_credit = selection.credits.get(participant.id)!;
    cursor = selection.selected.queue_position!;
    if (!order.includes(selection.selected.id)) order.push(selection.selected.id);
  }
  return order;
}
