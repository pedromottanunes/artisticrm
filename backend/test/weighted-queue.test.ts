import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compactQueuePositions,
  previewWeightedOrder,
  selectWeightedParticipant,
  type WeightedQueueParticipant,
} from '../src/weighted-queue.js';

function sequence(weights: number[], length: number) {
  const participants: WeightedQueueParticipant[] = weights.map((queue_weight, index) => ({
    id: String(index + 1),
    queue_position: index + 1,
    queue_weight,
    queue_credit: 0,
  }));
  const result: string[] = [];
  let lastPosition = 0;
  for (let index = 0; index < length; index++) {
    const selection = selectWeightedParticipant(participants, lastPosition)!;
    result.push(selection.selected.id);
    for (const participant of participants)
      participant.queue_credit = selection.credits.get(participant.id)!;
    lastPosition = selection.selected.queue_position!;
  }
  return { participants, result, lastPosition };
}

test('rodízio ponderado com pesos iguais preserva a sequência circular anterior', () => {
  assert.deepEqual(sequence([1, 1, 1, 1], 8).result, ['1', '2', '3', '4', '1', '2', '3', '4']);
});

test('rodízio ponderado suave entrega a proporção 2:1:1:1 sem concentrar o favorecido', () => {
  const { result } = sequence([2, 1, 1, 1], 10);
  assert.deepEqual(result.slice(0, 5), ['1', '2', '3', '4', '1']);
  assert.deepEqual(
    result.reduce<Record<string, number>>((counts, id) => {
      counts[id] = (counts[id] ?? 0) + 1;
      return counts;
    }, {}),
    { '1': 4, '2': 2, '3': 2, '4': 2 },
  );
});

test('prévia da equipe não duplica atendente com peso maior', () => {
  const { participants, lastPosition } = sequence([3, 1, 1, 1], 1);
  const preview = previewWeightedOrder(participants, lastPosition);
  assert.equal(new Set(preview).size, 4);
  assert.deepEqual([...preview].sort(), ['1', '2', '3', '4']);
});

test('compactação remove lacunas e preserva quem seria o próximo da fila', () => {
  const compacted = compactQueuePositions(
    [
      { id: 'kalleo', queue_position: 4 },
      { id: 'priscila', queue_position: 5 },
      { id: 'vanessa', queue_position: 6 },
      { id: 'vitoria', queue_position: 7 },
    ],
    5,
  );
  assert.deepEqual(Object.fromEntries(compacted.positions), {
    kalleo: 1,
    priscila: 2,
    vanessa: 3,
    vitoria: 4,
  });
  assert.equal(compacted.lastPosition, 2);
});
