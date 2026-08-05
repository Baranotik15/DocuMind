import type { JSX } from 'react'

import { Fragment } from 'react'

import { Box, Button, Group, Paper } from '@mantine/core'

import classes from './SegmentedToggle.module.css'

interface TabButtonProps {
  label: string
  isActive: boolean
  onClick: () => void
}

/**
 * Reuses the app's one "active" glow device (`--doc-mark-glow` +
 * `sparkOrange`, see AppLayout's active nav link) instead of inventing a new
 * one - filled yellow-gold with an outer glow when selected, muted/no-glow
 * otherwise. `radius={0}` deliberately - this button fills its entire half
 * of the shared toggle edge-to-edge (see the wrapping Paper below, which
 * clips the two halves to its own rounded outline via `overflow: hidden`)
 * rather than floating as a smaller pill/circle inside a padded card.
 */
function TabButton({ label, isActive, onClick }: TabButtonProps): JSX.Element {
  return (
    <Button
      onClick={onClick}
      aria-pressed={isActive}
      variant={isActive ? 'filled' : 'subtle'}
      color="sparkOrange"
      radius={0}
      px="lg"
      className={classes.tabButton}
      style={{
        boxShadow: isActive ? 'var(--doc-mark-glow)' : 'none',
        color: isActive ? undefined : 'var(--doc-text-muted)',
      }}
    >
      {label}
    </Button>
  )
}

interface SegmentedToggleProps<T extends string> {
  options: { value: T; label: string }[]
  value: T
  onChange: (value: T) => void
}

/**
 * Generalizes the Stats/Logs toggle's own one shared Paper + hairline
 * dividers + TabButton device to any number of options (used here for that
 * 2-option toggle and for the 4-option Day/7 Days/Month/Year range toggle
 * below) - same edge-to-edge fill, only the Paper's own outer corners
 * rounded via `overflow: hidden`.
 */
export function SegmentedToggle<T extends string>({ options, value, onChange }: SegmentedToggleProps<T>): JSX.Element {
  return (
    <Paper
      radius="lg"
      p={0}
      bg="var(--doc-surface)"
      withBorder
      style={{ boxShadow: '0 10px 20px -12px rgba(0, 0, 0, 0.5)', alignSelf: 'flex-start', overflow: 'hidden' }}
    >
      <Group gap={0} wrap="nowrap">
        {options.map((option, index) => (
          <Fragment key={option.value}>
            {index > 0 ? <Box aria-hidden="true" style={{ width: 1, alignSelf: 'stretch', backgroundColor: 'var(--doc-hairline)' }} /> : null}
            <TabButton label={option.label} isActive={value === option.value} onClick={() => onChange(option.value)} />
          </Fragment>
        ))}
      </Group>
    </Paper>
  )
}
