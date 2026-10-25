import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Message, TaskWithRelations, Workflow } from '@sindral/shared';
import { chatTriggersFeedback, getStep } from '@sindral/shared';
import { Markdown } from '@/components/Markdown';
import { formatTime } from '@/lib/format';

interface ChatTabProps {
  task: TaskWithRelations;
  workflow: Workflow | null;
  userInitial: string;
  onSend: (content: string) => void;
  sending: boolean;
  error?: string | null;
}

export function ChatTab({ task, workflow, userInitial, onSend, sending, error }: ChatTabProps) {
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const messageCount = task.messages.length;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messageCount]);

  const triggers = chatTriggersFeedback(task, workflow);
  const step = workflow ? getStep(workflow, task.currentStepId ?? workflow.entryStepId) : null;
  const feedbackTarget = workflow && step ? workflow.edges.find((e) => e.from === step.id && e.event === 'feedback') : null;
  const targetLabel = feedbackTarget && workflow ? getStep(workflow, feedbackTarget.to)?.label : null;

  function send() {
    const content = draft.trim();
    if (!content || sending) return;
    onSend(content);
    setDraft('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-5 space-y-4" role="log" aria-live="polite" aria-label="Conversation">
        {task.messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3" style={{ background: 'color-mix(in srgb, var(--color-primary) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 22%, transparent)' }}>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                <path d="M3 15L9 3L15 15" stroke="var(--color-node-agent-text)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5.5 11H12.5" stroke="var(--color-node-agent-text)" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </div>
            <p className="text-sm text-muted-foreground">No messages yet</p>
            <p className="text-xs text-muted-foreground mt-1">Send a message to guide the agent</p>
          </div>
        ) : (
          task.messages.map((msg) => <ChatMessage key={msg.id} msg={msg} userInitial={userInitial} />)
        )}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 p-4 border-t border-border">
        {error && (
          <p className="text-xs text-[#f87171] mb-2" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-end gap-2 rounded-lg px-3 py-2 bg-input border border-border focus-within:border-accent/40 transition-colors">
          <textarea
            aria-label="Message"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none leading-relaxed max-h-32"
            style={{ minHeight: '20px' }}
          />
          <button
            type="button"
            onClick={send}
            disabled={!draft.trim() || sending}
            aria-label="Send message"
            className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center transition-all disabled:opacity-30"
            style={{ background: draft.trim() ? 'var(--color-primary)' : 'color-mix(in srgb, var(--color-primary) 30%, transparent)' }}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
              <path d="M6 10V2M6 2L2 6M6 2L10 6" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1.5 px-1 flex items-center gap-1.5" data-testid="chat-hint">
          {triggers ? (
            <>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden="true" />
              Sending will trigger an agent revision{targetLabel ? ` (${targetLabel})` : ''}
            </>
          ) : (
            step?.output === 'design' ? <>Feedback is queued for the next design turn</> : <>Message is saved to the thread — no agent run will start</>
          )}
          <span className="text-muted-foreground/60">· Enter to send · Shift+Enter for new line</span>
        </p>
      </div>
    </div>
  );
}

function ChatMessage({ msg, userInitial }: { msg: Message; userInitial: string }) {
  const isUser = msg.role === 'user';
  const isSystem = msg.role === 'system';
  const optimistic = msg.id.startsWith('optimistic-');

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <span className="text-[10px] font-mono text-muted-foreground px-2 py-1 rounded bg-secondary/60 max-w-[80%] text-center">{msg.content}</span>
      </div>
    );
  }

  return (
    <div className={`flex gap-3 ${isUser ? 'flex-row-reverse' : ''}`} data-role={msg.role}>
      <div
        className="w-6 h-6 rounded-full shrink-0 flex items-center justify-center text-[10px] font-semibold mt-0.5"
        style={
          isUser
            ? { background: 'var(--color-secondary)', border: '1px solid var(--color-border-strong)', color: 'var(--color-secondary-foreground)' }
            : { background: 'color-mix(in srgb, var(--color-primary) 14%, transparent)', border: '1px solid color-mix(in srgb, var(--color-primary) 22%, transparent)', color: 'var(--color-node-agent-text)' }
        }
        aria-hidden="true"
      >
        {isUser ? userInitial : '∆'}
      </div>
      <div className={`max-w-[80%] flex flex-col gap-1 ${isUser ? 'items-end' : ''}`}>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono text-muted-foreground">{isUser ? 'You' : 'Sindral'}</span>
          <span className="text-[10px] font-mono text-muted-foreground">{formatTime(msg.createdAt)}</span>
          {msg.source === 'github' && (
            <span className="text-[9px] font-mono px-1 rounded bg-secondary text-muted-foreground" title="Imported from a GitHub PR comment">
              via GitHub
            </span>
          )}
          {optimistic && <span className="text-[9px] font-mono text-muted-foreground">sending…</span>}
        </div>
        <div
          className={`px-3 py-2 rounded-lg text-sm leading-relaxed ${optimistic ? 'opacity-70' : ''}`}
          style={
            isUser
              ? { background: 'var(--color-secondary)', border: '1px solid var(--color-border-strong)', color: 'var(--color-foreground)' }
              : { background: 'var(--color-card)', border: '1px solid var(--color-border)', color: 'var(--color-foreground)' }
          }
        >
          {isUser ? <span className="whitespace-pre-wrap break-words">{msg.content}</span> : <Markdown className="[&>*]:text-foreground">{msg.content}</Markdown>}
        </div>
      </div>
    </div>
  );
}
