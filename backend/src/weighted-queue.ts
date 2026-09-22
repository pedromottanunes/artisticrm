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
      participant.queue_weight >= 1,
  );
  if (!eligible.length) return;

  const totalWeight = eligible.reduce((sum, participant) => sum + participant.queue_weight, 0);
  const credits = new Map(
    eligible.map((participant) => [
      participant.id,
      participant.queue_credit + participant.queue_weight,
    ]),
  );
  const highest = Math.max(...credits.values());
  const selected = orderedAfter(eligible, lastPosition).find(
    (participant) => credits.get(participant.id) === highest,
  )!;
  credits.set(selected.id, credits.get(selected.id)! - totalWeight);
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
