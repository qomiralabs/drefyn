import type { Meta, StoryObj } from '@storybook/react-vite';
import { Skeleton } from '../src/react/index.ts';

const meta = {
  title: 'Components/Skeleton',
  parameters: {
    docs: {
      description: {
        component:
          'Placeholder blocks the size of the content they stand for, in the skeleton fill. No shimmer, no pulse, no spinner. Skeletons are hidden from screen readers; the region they fill sets aria-busy and is announced once.',
      },
    },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj;

export const Shapes: Story = {
  render: () => (
    <div className="flex flex-col gap-16 p-24 sm:p-48">
      <Skeleton />
      <Skeleton width="3/4" />
      <Skeleton width="1/2" />
      <Skeleton width="1/4" />
      <div className="flex items-center gap-12">
        <span className="size-icon-lg">
          <Skeleton shape="circle" />
        </span>
        <span className="h-control-md w-1/2">
          <Skeleton shape="block" />
        </span>
      </div>
    </div>
  ),
};

// What a page section shows while its text loads: the region is busy, the lines keep the
// final layout.
export const LoadingText: Story = {
  name: 'Loading text',
  render: () => (
    <section aria-labelledby="summary" aria-busy="true" className="max-w-measure p-24 sm:p-48">
      <h2 id="summary" className="text-title text-ink">
        Summary
      </h2>
      <div className="mt-16 flex flex-col gap-8 text-body-m">
        <Skeleton />
        <Skeleton />
        <Skeleton width="3/4" />
      </div>
    </section>
  ),
};

// A list loading inside its frame: the header stays and the rows keep their height.
export const LoadingRows: Story = {
  name: 'Loading rows',
  render: () => (
    <section aria-labelledby="components" aria-busy="true" className="p-24 sm:p-48">
      <h2 id="components" className="text-title text-ink">
        Components
      </h2>
      <ul className="mt-16" aria-hidden="true">
        {['1/2', '3/4', '1/4', '1/2', '3/4'].map((width, i) => (
          <li key={i} className="flex min-h-row-compact items-center gap-16 border-t border-rule">
            <span className="w-1/2">
              <Skeleton width={width as '1/2' | '3/4' | '1/4'} />
            </span>
            <span className="w-1/4">
              <Skeleton width="1/2" />
            </span>
          </li>
        ))}
      </ul>
    </section>
  ),
};
