export async function consumeServerSentEventStream(
  response: Response,
  onEvent: (data: string) => void,
): Promise<void> {
  const body = response.body;
  if (!body) {
    throw new Error('Streaming response did not include a readable body');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });

    let boundaryIndex = findEventBoundary(buffer);
    while (boundaryIndex !== -1) {
      const rawEvent = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + getBoundaryLength(buffer, boundaryIndex));
      emitEventData(rawEvent, onEvent);
      boundaryIndex = findEventBoundary(buffer);
    }

    if (done) {
      if (buffer.trim()) {
        emitEventData(buffer, onEvent);
      }
      return;
    }
  }
}

function findEventBoundary(buffer: string): number {
  const crlfBoundary = buffer.indexOf('\r\n\r\n');
  const lfBoundary = buffer.indexOf('\n\n');

  if (crlfBoundary === -1) {
    return lfBoundary;
  }

  if (lfBoundary === -1) {
    return crlfBoundary;
  }

  return Math.min(crlfBoundary, lfBoundary);
}

function getBoundaryLength(buffer: string, boundaryIndex: number): number {
  return buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2;
}

function emitEventData(rawEvent: string, onEvent: (data: string) => void): void {
  const dataLines = rawEvent
    .replace(/\r/g, '')
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return;
  }

  onEvent(dataLines.join('\n'));
}