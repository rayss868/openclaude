import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { BRAND_NAME, BRAND_TAGLINE } from '../../constants/brand.js'
import { publicBuildVersion } from '../../utils/version.js'
import { OcMonogram } from './OcMonogram.js'

const WELCOME_V2_WIDTH = 58
const RULE = '─'.repeat(WELCOME_V2_WIDTH)

export function WelcomeV2(): React.ReactElement {
  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column" alignItems="center">
      <Text>
        <Text bold color="brand">
          Welcome to {BRAND_NAME}
        </Text>
        <Text dimColor> v{publicBuildVersion}</Text>
      </Text>
      <Text dimColor>{RULE}</Text>
      <Box marginY={1}>
        <OcMonogram />
      </Box>
      <Text dimColor>{BRAND_TAGLINE}</Text>
    </Box>
  )
}
