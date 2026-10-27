'use client';
import type { ReactNode } from 'react';
import { Header, MenuSection as AriaMenuSection } from 'react-aria-components';

export interface MenuSectionProps {
  title: string;
  children: ReactNode;
}

// A labelled group of items. The header names the group for screen readers.
export function MenuSection({ title, children }: MenuSectionProps): ReactNode {
  return (
    <AriaMenuSection className="flex flex-col">
      <Header className="px-8 pt-8 pb-4 text-label text-secondary uppercase">{title}</Header>
      {children}
    </AriaMenuSection>
  );
}
