import '@mantine/core/styles.css'

import { MantineProvider, Title } from '@mantine/core'

export function App() {
  return (
    <MantineProvider>
      <Title order={1}>DocuMind</Title>
    </MantineProvider>
  )
}
