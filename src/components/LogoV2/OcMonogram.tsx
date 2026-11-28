import * as React from 'react'
import { Box, Text } from '../../ink.js'

const MONOGRAM = ['  ▄▀▀▀▄  ', ' █ O C █ ', '  ▀▄▄▄▀  ']

export function OcMonogram(): React.ReactElement {
  return (
    <Box flexDirection="column">
      {MONOGRAM.map((row, index) => (
        <Text key={index} color="brand" bold>
          {row}
        </Text>
      ))}
    </Box>
  )
}
