import { Platform, type ViewStyle } from 'react-native';

export const colors = {
  bg: '#F5F2EE',
  card: '#FAFAF8',
  textPrimary: '#1a1a1a',
  textSecondary: '#888884',
  textTertiary: '#b0aca6',
  separator: '#e8e4de',
  accent: '#E8A84A',
  accentBgSoft: '#FDF3E3',
  accentText: '#C8842A',
  pillBg: '#EDE9E3',
  rating: {
    againBg: '#FDE8E8',
    againText: '#C84B4B',
    hardBg: '#EDE9E3',
    hardText: '#888884',
    goodBg: '#E8F5EE',
    goodText: '#3A9B6F',
    easyBg: '#FDF3E3',
    easyText: '#C8842A',
  },
} as const;

export const radius = {
  card: 20,
  inner: 14,
  pill: 40,
  thumb: 12,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const shadow: ViewStyle = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
  },
  android: {
    elevation: 2,
  },
  default: {},
}) as ViewStyle;

export const topShadow: ViewStyle = Platform.select({
  ios: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.04,
    shadowRadius: 8,
  },
  android: {
    elevation: 4,
  },
  default: {},
}) as ViewStyle;

export const fontFamily = {
  regular: undefined,
  bold: undefined,
} as const;

export const text = {
  hero: {
    fontSize: 32,
    fontWeight: '400',
    color: colors.textPrimary,
    letterSpacing: -0.5,
  },
  heroBold: {
    fontWeight: '700',
  },
  greeting: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.3,
  },
  streakNumber: {
    fontSize: 52,
    fontWeight: '700',
    color: colors.accent,
    letterSpacing: -1,
  },
  screenTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.textPrimary,
    letterSpacing: -0.2,
  },
  cardTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.textPrimary,
  },
  body: {
    fontSize: 15,
    fontWeight: '400',
    color: colors.textPrimary,
    lineHeight: 22,
  },
  caption: {
    fontSize: 13,
    fontWeight: '400',
    color: colors.textSecondary,
  },
  micro: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.textTertiary,
    letterSpacing: 0.4,
    textTransform: 'uppercase',
  },
} as const;
