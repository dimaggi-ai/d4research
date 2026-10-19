import type { ColorValue } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedPath = withUniwind(Path);

// Glyphs from assets/prod/logo.svg (Latin Modern Roman: italic d, upright 4), in font units with y up.
const D_GLYPH =
  "M535 143C535 153 527 153 520 153C508 153 507 152 501 130C487 74 468 11 434 11C408 11 408 38 408 52C408 59 408 74 414 98L557 669C558 672 560 682 560 682C560 691 554 694 546 694C543 694 533 693 530 692L431 684C419 683 408 682 408 663C408 652 418 652 432 652C480 652 482 645 482 635C482 632 479 618 479 618L421 384C406 415 379 442 337 442C226 442 108 290 108 144C108 59 154 -11 229 -11C265 -11 309 10 349 59C360 10 397 -11 432 -11C469 -11 490 14 505 45C523 83 535 143 535 143ZM355 122C347 91 286 11 231 11C184 11 176 70 176 100C176 150 207 267 225 309C250 370 296 420 337 420C345 420 368 419 386 391C396 375 406 346 406 327C406 324 405 320 403 314Z";
const FOUR_GLYPH =
  "M471 165V196H371V651C371 671 371 677 355 677C346 677 343 677 335 665L28 196V165H294V78C294 42 292 31 218 31H197V0C238 3 290 3 332 3C374 3 427 3 468 0V31H447C373 31 371 42 371 78V165ZM300 196H56L300 569Z";

// Keep the inherited component API; artwork is the d4 mark.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 890 / 715;
  return (
    <Svg
      accessibilityLabel="d4"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="100 -700 890 715"
    >
      <G transform="scale(1,-1)">
        <ThemedPath
          d={D_GLYPH}
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
        />
        <ThemedPath
          d={FOUR_GLYPH}
          transform="translate(511 0)"
          color={props.color}
          colorClassName={props.colorClassName}
          fill="currentColor"
        />
      </G>
    </Svg>
  );
}
