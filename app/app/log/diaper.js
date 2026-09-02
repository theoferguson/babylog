import { useState } from 'react';
import InstantForm, { Choice } from '../../src/InstantForm';
import { POO_COLOURS, POO_TEXTURES } from '../../src/EventFields';
import { types } from '../../src/theme';

const SIZES = ['small', 'medium', 'large'].map((v) => ({ value: v, label: v }));

export default function Diaper() {
  const [pee, setPee] = useState(null);
  const [poo, setPoo] = useState(null);
  const [color, setColor] = useState(null);
  const [consistency, setConsistency] = useState(null);
  const tint = types.diaper.fill;

  return (
    <InstantForm
      type="diaper"
      valid={!!(pee || poo)}
      build={() => ({
        ...(pee ? { pee } : {}),
        ...(poo ? { poo } : {}),
        ...(poo && color ? { color } : {}),
        ...(poo && consistency ? { consistency } : {}),
      })}
    >
      <Choice label="Pee" options={SIZES} value={pee} onChange={setPee} tint={tint} />
      <Choice label="Poo" options={SIZES} value={poo} onChange={setPoo} tint={tint} />
      {poo ? (
        <>
          <Choice
            label="Colour"
            options={POO_COLOURS}
            value={color}
            onChange={setColor}
            tint={tint}
          />
          <Choice
            label="Consistency"
            options={POO_TEXTURES}
            value={consistency}
            onChange={setConsistency}
            tint={tint}
          />
        </>
      ) : null}
    </InstantForm>
  );
}
