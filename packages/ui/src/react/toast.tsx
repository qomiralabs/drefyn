'use client';
import type { ReactNode } from 'react';

export type ToastTone = 'neutral' | 'error';

export interface ToastInput {
  // Plain words. Never content bodies or personal data.
  title: string;
  description?: string;
  undo?: () => void | Promise<void>;
  tone?: ToastTone;
}

export interface ToastHandle {
  close(): void;
}

// TODO(#58): React Aria's toast queue and region behind this signature.
export const toast: (input: ToastInput) => ToastHandle = () => ({ close: () => undefined });

export const ToastRegion: () => ReactNode = () => null;
