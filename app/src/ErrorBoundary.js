import { Component } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { space } from './theme';
import { Button, s } from './ui';

// A render error would otherwise take the whole app down with a blank screen and
// nothing to report. This turns it into a message you can read out.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <ScrollView style={s.screen} contentContainerStyle={{ padding: space, gap: 12, paddingTop: 80 }}>
        <Text style={s.h1}>Something broke</Text>
        <Text style={s.muted}>
          Nothing you logged is lost — this is a display error. Tell Theo what it says.
        </Text>
        <View style={[s.error, { marginTop: 8 }]}>
          <Text style={s.errorText}>{String(error?.message || error)}</Text>
        </View>
        {error?.stack ? (
          <Text style={[s.muted, { fontSize: 11 }]} selectable>
            {String(error.stack).split('\n').slice(0, 6).join('\n')}
          </Text>
        ) : null}
        <Button title="Try again" onPress={() => this.setState({ error: null })} />
      </ScrollView>
    );
  }
}
