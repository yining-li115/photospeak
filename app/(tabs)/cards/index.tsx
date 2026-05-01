import { SafeAreaView, StyleSheet, Text } from 'react-native';

export default function CardsScreen() {
  return (
    <SafeAreaView style={styles.container}>
      <Text style={styles.title}>Cards</Text>
      <Text style={styles.subtitle}>SRS review — coming soon</Text>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    opacity: 0.6,
  },
});
