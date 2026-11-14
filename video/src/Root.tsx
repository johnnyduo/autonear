import React from 'react';
import { AbsoluteFill, Composition, Html5Audio, Sequence, staticFile } from 'remotion';
import { loadFonts } from './fonts';
import { FPS, H, W } from './theme';
import { buildTimeline } from './lib/timeline';
import { Captions, Provenance, Sfx } from './components';
import { SCENES } from './scenes';
import { CineMain } from './cine/Main';
import { buildTimeline as buildCine } from './cine/timeline';
import { CineMain as CineMain2 } from './cine2/Main';
import { buildTimeline as buildCine2 } from './cine2/timeline';
import { PdMain } from './pd/Main';
import { buildTimeline as buildPd } from './pd/timeline';
import { DmMain } from './dm/Main';
import { buildTimeline as buildDm } from './dm/timeline';

loadFonts();

const Main: React.FC = () => {
  const tl = buildTimeline();
  return (
    <AbsoluteFill>
      <Html5Audio src={staticFile('music/bed.mp3')} volume={0.3} />
      {tl.scenes.map((s) => {
        const Scene = SCENES[s.id];
        return (
          <Sequence key={s.id} name={s.id} from={s.from} durationInFrames={s.frames} layout="none">
            <Sequence from={0} durationInFrames={s.frames} layout="none">{Scene ? <Scene s={s} /> : null}</Sequence>
            <Sequence from={s.narrationFrom} layout="none"><Html5Audio src={staticFile(s.file)} /></Sequence>
            {s.from > 0 ? <Sfx s={{ ...s, narrationFrom: 0 }} name="whoosh" at={0} volume={0.9} /> : null}
            <Provenance tag={s.tag} s={s} />
            <Captions s={s} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};

export const RemotionRoot: React.FC = () => {
  const tl = buildTimeline();
  const cine = buildCine();
  const cine2 = buildCine2();
  const pd = buildPd();
  const dm = buildDm();
  return (
    <>
      <Composition id="Main" component={Main} durationInFrames={tl.totalFrames} fps={FPS} width={W} height={H} />
      <Composition id="Cinematic" component={CineMain} durationInFrames={cine.totalFrames} fps={FPS} width={W} height={H} />
      <Composition id="ProductDemo" component={PdMain} durationInFrames={pd.totalFrames} fps={FPS} width={W} height={H} />
      <Composition id="ProductDemoV3" component={DmMain} durationInFrames={dm.totalFrames} fps={FPS} width={W} height={H} />
      <Composition id="Cinematic2" component={CineMain2} durationInFrames={cine2.totalFrames} fps={FPS} width={W} height={H} />
    </>
  );
};
