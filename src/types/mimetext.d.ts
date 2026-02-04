// src/types/mimetext.d.ts
// Type declarations for mimetext package

declare module "mimetext" {
  interface Mailbox {
    addr: string;
    name?: string;
  }

  interface MessageContent {
    contentType: string;
    data: string;
    encoding?: string;
    headers?: Record<string, string>;
  }

  interface MIMEMessage {
    setSender(sender: Mailbox | string): this;
    setRecipient(recipient: string | string[]): this;
    setTo(recipient: string | string[]): this;
    setCc(recipient: string | string[]): this;
    setBcc(recipient: string | string[]): this;
    setSubject(subject: string): this;
    setHeader(name: string, value: string): this;
    addMessage(content: MessageContent): this;
    addAttachment(content: MessageContent): this;
    asRaw(): string;
    asEncoded(): string;
  }

  export function createMimeMessage(): MIMEMessage;
}
