---
name: ui-design
description: UI design and implementation guidelines for creating polished, responsive React components using Mantine UI
---

# UI Design Skill

Use this skill when implementing UI components, creating new features, or building user interfaces in the project frontend.

**Additional Resources:**
- **Style Guide**: `STYLE_GUIDE.md` (in this folder) - Comprehensive design system with color palettes, typography, spacing, and component patterns

## Technology Stack

**Frontend Framework:**
- React 18+ with TypeScript
- Mantine UI v8 component library
- Apollo Client for GraphQL data fetching
- Vite for build tooling

**DO NOT:**
- Use Tailwind CSS (project uses Mantine)
- Create standalone HTML files (use React components)
- Use inline styles with `style={{}}` (use Mantine props)
- Use hardcoded colors (use theme tokens)

## Design Philosophy

**Design Inspiration:**
- S-Tier SaaS standards: Linear, Stripe, Vercel, Airbnb
- Focus on: clarity, polish, consistency, attention to detail
- Favor light mode for professional/business contexts
- Use subtle contrast over harsh blacks/whites

**Typography:**
- Font family: Inter (from theme.ts)
- Font weights: Use Medium (500) or Semibold (600) - avoid Bold (700)
- Large titles (>20px): Use tighter letter spacing for polish
- Be precise with font selection and sizing

## Theme & Styling

**REQUIRED: Use theme tokens from `src/theme.ts`**

```tsx
import { useMantineTheme } from '@mantine/core';

// Color palette
const theme = useMantineTheme();
theme.colors.brand         // Primary brand color
theme.colors.accent        // Accent color for highlights
theme.colors.gray          // Neutral grays
theme.colors.indigo        // Interactive elements

// Spacing (use Mantine props, not px)
<Box p="md" m="lg" gap="sm">  // sm, md, lg, xl

// Border radius
radius="md"  // xs, sm, md, lg, xl

// Shadows
shadow="sm"  // xs, sm, md, lg, xl
```

**BANNED: Hardcoded values**
```tsx
// ❌ NEVER DO THIS
<Box style={{ color: "#666", padding: "16px" }}>
<Box bg="#4263EB">

// ✅ ALWAYS DO THIS
<Box c="dimmed" p="md">
<Box bg={theme.colors.brand[9]}>
```

## Component Patterns

**ALWAYS use Mantine components over raw HTML:**

```tsx
// ✅ CORRECT
import { Box, Stack, Group, Text, Button } from '@mantine/core';

<Stack gap="md">
  <Text size="xl" fw={600}>Title</Text>
  <Group justify="space-between">
    <Button variant="filled">Primary</Button>
    <Button variant="outline">Secondary</Button>
  </Group>
</Stack>

// ❌ WRONG
<div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
  <h2 style={{ fontSize: '20px', fontWeight: 'bold' }}>Title</h2>
  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
    <button className="primary">Primary</button>
    <button className="secondary">Secondary</button>
  </div>
</div>
```

## Responsive Design

**REQUIRED: Use Mantine's responsive props**

```tsx
import { SimpleGrid, Stack } from '@mantine/core';

// Responsive grid
<SimpleGrid
  cols={{ base: 1, sm: 2, lg: 3 }}
  spacing={{ base: "sm", md: "lg" }}
>
  {items.map(item => <Card key={item.id} {...item} />)}
</SimpleGrid>

// Responsive spacing/sizing
<Box
  p={{ base: "md", lg: "xl" }}
  w={{ base: "100%", sm: "80%", lg: "60%" }}
>
  {content}
</Box>
```

**Breakpoints:**
- `base`: Mobile (375px+)
- `sm`: Tablet (768px+)
- `lg`: Desktop (1440px+)

## Forms

**REQUIRED: Use Mantine's useForm hook**

```tsx
import { useForm } from '@mantine/form';
import { TextInput, Button, Stack } from '@mantine/core';

function ItemForm({ onSubmit }: { onSubmit: (data: ItemFormData) => void }) {
  const form = useForm<ItemFormData>({
    initialValues: { name: '', quantity: 0 },
    validate: {
      name: (value) => (value.length < 2 ? 'Name too short' : null),
      quantity: (value) => (value < 1 ? 'Must have at least 1' : null),
    },
  });

  return (
    <form onSubmit={form.onSubmit(onSubmit)}>
      <Stack gap="md">
        <TextInput
          label="Item Name"
          placeholder="Enter item name"
          {...form.getInputProps('name')}
        />
        <NumberInput
          label="Quantity"
          placeholder="0"
          {...form.getInputProps('quantity')}
        />
        <Button type="submit">Create Item</Button>
      </Stack>
    </form>
  );
}
```

## Modals & Overlays

**REQUIRED: Use useDisclosure for modal state**

```tsx
import { useDisclosure } from '@mantine/hooks';
import { Modal, Button } from '@mantine/core';

function ItemManager() {
  const [opened, { open, close }] = useDisclosure(false);

  return (
    <>
      <Button onClick={open}>Add Item</Button>
      <Modal opened={opened} onClose={close} title="Add Item" size="lg">
        <ItemForm onSubmit={(data) => {
          createItem(data);
          close();
        }} />
      </Modal>
    </>
  );
}
```

## Loading States

**REQUIRED: Use Skeleton for loading states**

```tsx
import { Skeleton, Stack } from '@mantine/core';

function ItemDetails({ itemId }: { itemId: number }) {
  const { data, loading } = useGetItemQuery({ variables: { id: itemId } });

  if (loading && !data) {
    return (
      <Stack gap="md">
        <Skeleton height={24} width="60%" />
        <Skeleton height={16} width="40%" />
        <Skeleton height={100} />
      </Stack>
    );
  }

  return <Box>{/* render data */}</Box>;
}
```

## User Feedback

**REQUIRED: Use notifications for user feedback**

```tsx
import { notifications } from '@mantine/notifications';

// Success
notifications.show({
  title: 'Item created',
  message: `${item.name} is now active`,
  color: 'green',
});

// Error
notifications.show({
  title: 'Failed to create item',
  message: error.message,
  color: 'red',
});
```

## Icons

**Use Tabler Icons React:**

```tsx
import { IconPlus, IconTrash, IconEdit } from '@tabler/icons-react';

<Button leftSection={<IconPlus size={16} />}>
  Add Item
</Button>
```

**Icon sizing:**
- Small actions: `size={16}`
- Medium actions: `size={20}`
- Large headers: `size={24}`

## Data Fetching

**REQUIRED: Use Apollo Client hooks**

```tsx
import { useGetItemsQuery, useCreateItemMutation } from '@/generated/graphql';

function ItemList() {
  const { data, loading, error } = useGetItemsQuery();
  const [createItem] = useCreateItemMutation();

  if (loading) return <Skeleton />;
  if (error) return <Text c="red">Error: {error.message}</Text>;

  return (
    <Stack gap="md">
      {data?.items.map(item => (
        <ItemCard key={item.id} item={item} />
      ))}
    </Stack>
  );
}
```

## Visual Hierarchy

**Best practices:**
- Use subtle dividers (`<Divider />`) to separate sections
- Use `c="dimmed"` for secondary text
- Use appropriate font weights (fw={500} or fw={600})
- Add `shadow="sm"` to cards for depth
- Use consistent spacing (gap="md" for related items, gap="xl" for sections)

## Component File Structure

```text
src/
├── components/
│   ├── forms/          # Reusable form components
│   └── layout/         # Layout components (AppShell, Header, etc.)
├── features/
│   ├── items/          # Feature-specific components
│   └── users/          # User-specific components
└── theme.ts            # Mantine theme configuration
```

## Checklist

Before finalizing UI implementation, verify:
- [ ] Uses Mantine components (not raw HTML)
- [ ] Uses theme tokens (not hardcoded colors/spacing)
- [ ] Responsive design with Mantine props (`cols={{ base: 1, lg: 3 }}`)
- [ ] Loading states with `<Skeleton />`
- [ ] Form validation with `useForm`
- [ ] Modal state with `useDisclosure`
- [ ] User feedback with `notifications`
- [ ] Proper TypeScript types
- [ ] Apollo Client for data fetching
- [ ] Consistent spacing (sm, md, lg, xl)
- [ ] Font weights: Medium (500) or Semibold (600)
- [ ] Icons from @tabler/icons-react
- [ ] Original design respected (if provided)
