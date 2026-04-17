import React, { useState, useEffect } from 'react';
import type { RendererOutputBlock } from '../../shared/schema';
import './styles.css';

declare global {
  interface Window {
    electronAPI: {
      submitInput: (input: string) => Promise<unknown>;
      onOutput: (callback: (event: unknown, data: RendererOutputBlock) => void) => void;
      removeAllListeners: (event: string) => void;
    };
  }
}

export function App() {
  const [input, setInput] = useState('');
  const [outputBlocks, setOutputBlocks] = useState<RendererOutputBlock[]>([]);

  useEffect(() => {
    window.electronAPI.onOutput((event, data) => {
      setOutputBlocks((previous) => [...previous, data]);
    });

    return () => {
      window.electronAPI.removeAllListeners('output');
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (input.trim()) {
      await window.electronAPI.submitInput(input);
      setInput('');
    }
  };

  return (
    <div className="app">
      <section className="output-pane" aria-label="output-region">
        {outputBlocks.length === 0 ? (
          <div className="output-empty">No output yet.</div>
        ) : outputBlocks.map((block) => (
          block.collapsed ? (
            <details key={block.id} className={`output-block output-block-${block.type}`}>
              <summary>{block.title}</summary>
              <pre>{block.content}</pre>
            </details>
          ) : (
            <article key={block.id} className={`output-block output-block-${block.type}`}>
              <header className="output-block-title">{block.title}</header>
              <pre className="output-block-content">{block.content}</pre>
            </article>
          )
        ))}
      </section>
      <form className="input-pane" aria-label="input-region" onSubmit={handleSubmit}>
        <label className="input-label" htmlFor="pueblo-input">pueblo&gt;</label>
        <input
          id="pueblo-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Enter command or task..."
          autoFocus
        />
        <button type="submit">Send</button>
      </form>
    </div>
  );
}