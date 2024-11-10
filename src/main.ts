/**
 *
 * Inspired by:
 * Course Notes showing Asteroids in FRP: https://tgdwyer.github.io/asteroids/
 * Functional Reactive Programming Techniques: https://tgdwyer.github.io/functionalreactiveprogramming/#pure-frp-solution
 * Week 3 & 4 Applied Exercises
 * midi sourced from: https://musescore.com/user/30454207/scores/5652825
 *
 */

import "./style.css";

import {
    combineLatest,
    from,
    fromEvent,
    interval,
    merge,
    Observable,
    timer,
} from "rxjs";
import {
    map,
    filter,
    scan,
    switchMap,
    takeUntil,
    tap,
    last,
    mergeMap,
    finalize,
    withLatestFrom,
    debounceTime,
    delay,
    startWith,
    take,
    concatMap,
} from "rxjs/operators";
import * as Tone from "tone";
import { SampleLibrary } from "./tonejs-instruments";

/** CONSTANTS */

const Viewport = {
    CANVAS_WIDTH: 200,
    CANVAS_HEIGHT: 400,
} as const;

const Constants = {
    TICK_RATE_MS: 16,
    SONG_NAME: "IWonder",
    BOTTOM_ROW: 350,
} as const;

const Note = {
    RADIUS: 0.07 * Viewport.CANVAS_WIDTH,
};

/** USER INPUT */

//User keyboard inputs for playing notes
type Key = "KeyH" | "KeyJ" | "KeyK" | "KeyL";

/** UTILITY FUNCTION */
// inspired by week 4 applied
function lcg(seed: number): () => number {
    return () => {
        seed = (seed * 67890 + 34086315) % 12345;
        return seed / 12345;
    };
}

/** STATE PROCESSING */

// Types to represent note specifications and state
type NoteSpec = {
    user_played: boolean;
    instrument_name: string;
    velocity: number;
    pitch: number;
    start: number;
    end: number;
};

type ExtendedNoteSpec = NoteSpec & {
    timeToRelease: number;
    column: number;
};

type State = Readonly<{
    gameEnd: boolean;
}>;

const parseCSV = (
    csv: string,
    samples: { [key: string]: Tone.Sampler },
): NoteSpec[] => {
    const lines = csv.split("\n");

    // Extract unique instruments from CSV
    const instrumentsFromCSV = new Set<string>();

    const notes = lines
        .slice(1) // Skip header
        .filter((line) => line.trim() !== "") // Filter out empty lines
        .map((line) => {
            const [user_played, instrument_name, velocity, pitch, start, end] =
                line.split(",");

            // Track instruments
            if (instrument_name) {
                instrumentsFromCSV.add(instrument_name.trim());
            }

            return {
                user_played: user_played === "True",
                instrument_name: instrument_name.trim(),
                velocity: parseFloat(velocity) / 127, // Convert to range [0,1]
                pitch: parseInt(pitch),
                start: parseFloat(start),
                end: parseFloat(end),
            };
        });

    // Find any missing instruments
    const missingInstruments = Array.from(instrumentsFromCSV).filter(
        (instrument) => !(instrument in samples),
    );

    if (missingInstruments.length > 0) {
        console.warn("Missing Instruments in Samples:", missingInstruments);
    }

    return notes;
};

/*
 *Initial score value
 */
const initialScore = 0;

/**
 * NOTE HANDLING
 */

/**
 * Assigns a note to a column based on its pitch.
 *
 *
 * @param pitch The pitch of the note
 * @returns The column number (0 to 3)
 */
const assignColumnByPitch = (pitch: number): number => {
    // Assign to columns based on pitch
    return pitch % 4; // Returns 0, 1, 2, or 3
};

/**
 * Determines the colour of the note based on its assigned column.
 *
 * @param column The column number (0 to 3)
 * @returns The colour associated with the column
 */
const getColourByColumn = (column: number): string => {
    switch (column) {
        case 0:
            return "green"; // Leftmost column
        case 1:
            return "red";
        case 2:
            return "blue";
        case 3:
            return "yellow"; // Rightmost column
        default:
            return "black"; // Default color in case of error
    }
};

/**
 * RENDERING (SIDE EFFECTS)
 **/

/**
 * Displays a SVG element on the canvas. Brings to foreground.
 * @param elem SVG element to display
 */
const show = (elem: SVGGraphicsElement) => {
    elem.setAttribute("visibility", "visible");
    elem.parentNode!.appendChild(elem);
};

/**
 * Hides a SVG element on the canvas.
 * @param elem SVG element to hide
 */
const hide = (elem: SVGGraphicsElement) =>
    elem.setAttribute("visibility", "hidden");

/**
 * Creates an SVG element with the given properties.
 *
 * See https://developer.mozilla.org/en-US/docs/Web/SVG/Element for valid
 * element names and properties.
 *
 * @param namespace Namespace of the SVG element
 * @param name SVGElement name
 * @param props Properties to set on the SVG element
 * @returns SVG element
 */
const createSvgElement = (
    namespace: string | null,
    name: string,
    props: Record<string, string> = {},
) => {
    const elem = document.createElementNS(namespace, name) as SVGElement;
    Object.entries(props).forEach(([k, v]) => elem.setAttribute(k, v));
    return elem;
};

/** Helper function to get column index from key code
 * @param keyCode The key code of the pressed key
 * @returns The column index (0 to 3) or -1 if the key code doesn't match
 */
function getColumnIndexFromKeyCode(keyCode: string): number {
    switch (keyCode) {
        case "KeyH":
            return 0;
        case "KeyJ":
            return 1;
        case "KeyK":
            return 2;
        case "KeyL":
            return 3;
        default:
            return -1;
    }
}

/**
 * MAIN GAME FUNCTION
 */
export function main(
    csvContents: string,
    samples: { [key: string]: Tone.Sampler },
) {
    /** GAME SETUP */
    // Initialize RNG seed
    const rng = lcg(Date.now()); // Fixed seed for reproducibility

    // Canvas elements
    const svg = document.querySelector("#svgCanvas") as SVGGraphicsElement &
        HTMLElement;
    const gameover = document.querySelector("#gameOver") as SVGGraphicsElement &
        HTMLElement;

    svg.setAttribute("height", `${Viewport.CANVAS_HEIGHT}`);
    svg.setAttribute("width", `${Viewport.CANVAS_WIDTH}`);

    // Text fields
    const multiplier = document.querySelector("#multiplierText") as HTMLElement;
    const scoreText = document.querySelector("#scoreText") as HTMLElement;
    const highScoreText = document.querySelector(
        "#highScoreText",
    ) as HTMLElement;

    /** RENDERING AND GAMEPLAY FUNCTION */

    /**
     * Rendering function to show/hide game over screen.
     * @param state The current game state
     */
    function render(state: State) {
        if (state.gameEnd) {
            show(gameover);
        } else {
            hide(gameover);
        }
    }

    /**
     * Creates an SVG circle element for a note.
     * @param note The note specification
     * @returns The created SVG circle element
     */
    const createNoteCircle = (note: ExtendedNoteSpec): SVGCircleElement => {
        const columnPositions = [20, 40, 60, 80]; // cx positions for each column
        return createSvgElement(svg.namespaceURI, "circle", {
            r: `${Note.RADIUS}`,
            cx: `${columnPositions[note.column]}%`,
            cy: "0",
            style: `fill: ${getColourByColumn(note.column)}`,
        }) as SVGCircleElement;
    };

    // Play background notes
    const playBackgroundNotes =
        (samples: { [key: string]: Tone.Sampler }) =>
        (note: ExtendedNoteSpec) => {
            if (!note.user_played) {
                samples[note.instrument_name].triggerAttackRelease(
                    Tone.Frequency(note.pitch, "midi").toNote(),
                    note.end - note.start,
                    undefined,
                    note.velocity,
                );
            }
        };

    /** Function to play the user-played note */
    const playUserPlayedNote = (
        note: ExtendedNoteSpec,
        samples: { [key: string]: Tone.Sampler },
    ) => {
        samples[note.instrument_name].triggerAttackRelease(
            Tone.Frequency(note.pitch, "midi").toNote(),
            note.end - note.start,
            undefined,
            note.velocity,
        );
    };

    // Function to play a random note on wrong input
    const playRandomNote = () => {
        const randomValue = rng(); // Generate a random number using the seeded RNG
        const availableInstruments = Object.keys(samples);
        const randomIndex = Math.floor(
            randomValue * availableInstruments.length,
        );
        const randomInstrument = availableInstruments[randomIndex];
        const randomPitch = Math.floor(randomValue * 88 + 21);

        // Ensure random duration is between 0.1 and 0.5 seconds (so it is not too short)
        const randomDuration = 0.1 + rng() * 0.4;

        // Set a random velocity between 0.5 and 1 (so it is audible)
        const randomVelocity = 0.5 + rng() * 0.5;

        samples[randomInstrument].triggerAttackRelease(
            Tone.Frequency(randomPitch, "midi").toNote(),
            randomDuration.toFixed(2),
            undefined,
            randomVelocity,
        );
    };

    /** PARSE CSV AND PREPARE DATA */

    const notes = parseCSV(csvContents, samples);

    // Extend notes with additional properties like column and timeToRelease
    const extendedNotes = notes.map((note) => ({
        ...note,
        timeToRelease: note.start - Constants.TICK_RATE_MS / 1000,
        column: assignColumnByPitch(note.pitch),
    }));

    // Separate notes into background and user-played notes
    const backgroundNotes = extendedNotes.filter((note) => !note.user_played);
    const userPlayedNotes = extendedNotes.filter((note) => note.user_played);

    /** NOTE ANIMATION AND SOUND PLAYBACK */

    // Observable to emit user-played notes based on their start time
    const userNotes$: Observable<ExtendedNoteSpec> = from(userPlayedNotes).pipe(
        mergeMap((note: ExtendedNoteSpec) => {
            return timer(note.start * 1000 + 2000).pipe(
                map(() => note), // Emit note object after timer completes
            );
        }),
    );

    userNotes$.subscribe((note) => {});

    /** MANAGE GAME END CONDITIONS */

    // Observable to track when all notes have been played
    const gameEnd$: Observable<State> = merge(userNotes$, backgroundNotes).pipe(
        last(), // Wait until the last emitted note
        delay(2000), // 2-second delay
        map(() => ({ gameEnd: true }) as State), // Set state to gameEnd
    );

    // Subscription to handle state changes and game rendering
    gameEnd$.subscribe((state) => {
        render(state);
    });

    /** USER INPUT HANDLING */

    // Observable to track user key presses with timestamps
    const gameStartTime = Date.now();
    const keyPresses$: Observable<{ code: Key; time: number }> =
        fromEvent<KeyboardEvent>(document, "keypress").pipe(
            map((event) => ({
                code: event.code as Key,
                time: Date.now() - gameStartTime,
            })),
            debounceTime(50),
            takeUntil(gameEnd$), // Stop listening to user input when game ends
        );

    keyPresses$.subscribe((key) => {});

    /** USER SCORING AND FEEDBACK */

    // Combine user key presses and user notes
    const combined$: Observable<{
        note: ExtendedNoteSpec;
        isCorrectTiming: boolean;
        isCorrectColumn: boolean;
    }> = keyPresses$.pipe(
        withLatestFrom(userNotes$), // Combine only when a key press occurs
        map(([keyPress, note]) => {
            // Check for correct timing and column only if there's a user key press
            const actualNoteStartTime = note.start * 1000 + 2000;
            const margin = 150; // Margin of error in ms (for leniency)

            const isCorrectTiming =
                keyPress.time >= actualNoteStartTime - margin &&
                keyPress.time <= actualNoteStartTime + margin;

            const keyColumn = getColumnIndexFromKeyCode(keyPress.code);
            const isCorrectColumn = keyColumn === note.column;

            return {
                note,
                isCorrectTiming,
                isCorrectColumn,
            };
        }),
    );

    // Observable to handle score based on user inputs
    const score$: Observable<number> = combined$.pipe(
        map(({ isCorrectTiming, isCorrectColumn }) =>
            isCorrectTiming && isCorrectColumn ? 1 : 0,
        ),
        scan((acc, value) => acc + value, initialScore), // Accumulate score
        startWith(initialScore),
    );

    score$.subscribe((score) => {
        scoreText.innerText = score.toString(); // Update score UI element
    });

    // Delay animation and sound playback logic by 2 seconds
    timer(2000)
        .pipe(
            switchMap(() =>
                from(extendedNotes).pipe(
                    // flattens each note's observable into a single observable stream
                    mergeMap((note: ExtendedNoteSpec) => {
                        // Calculate distance note falls from top to bottom
                        const noteDistance = Constants.BOTTOM_ROW - note.start;
                        // Calculate the animation duration based on the distance and a speed factor
                        const animationDuration = (noteDistance / 1.25) * 4;

                        // Observable for sound playback at the exact start time
                        const sound$ = timer(note.start * 1000).pipe(
                            // transforms timer event to trigger the background note playback
                            map(() => playBackgroundNotes(samples)(note)),
                        );

                        // Observable to start animation slightly before note plays (so it reaches bottom row in time to play)
                        const animationStart$ = timer(
                            note.start * 1000 - animationDuration,
                        ).pipe(
                            // performs side effects without modifying data stream
                            map(() => {
                                if (note.user_played) {
                                    // Create note for user played notes
                                    const noteCircle = createNoteCircle(note);
                                    svg.appendChild(noteCircle);

                                    // Observable for animating note circle down
                                    const animation$ = interval(
                                        Constants.TICK_RATE_MS,
                                    ).pipe(
                                        // Calculate elapsed time at each interval
                                        map(
                                            (tick) =>
                                                tick * Constants.TICK_RATE_MS,
                                        ),
                                        // Stop animation after duration
                                        takeUntil(timer(animationDuration)),
                                        // Update note circle position based on elapsed time
                                        map((elapsed) => {
                                            const yPos =
                                                (elapsed / animationDuration) *
                                                (Constants.BOTTOM_ROW +
                                                    Note.RADIUS);
                                            noteCircle.setAttribute(
                                                "cy",
                                                `${yPos}`,
                                            );
                                        }),
                                        // cleans up after the animation is complete
                                        finalize(() => {
                                            // Remove note circle after animation complete
                                            svg.removeChild(noteCircle);
                                        }),
                                    );
                                    // Start animation
                                    animation$.subscribe();
                                }
                            }),
                        );

                        // Merge sound playback and animation observables into a single stream
                        return merge(animationStart$, sound$);
                    }),
                ),
            ),
        )
        .subscribe();

    // Subscription to handle correct and incorrect inputs
    combined$.subscribe(({ note, isCorrectTiming, isCorrectColumn }) => {
        if (isCorrectTiming && isCorrectColumn) {
            playUserPlayedNote(note, samples);
        } else if (isCorrectTiming && !isCorrectColumn) {
            playRandomNote();
        } else if (isCorrectColumn && !isCorrectTiming) {
            playRandomNote();
        } else {
            playRandomNote();
        }
    });
}

// The following simply runs your main function on window load.  Make sure to leave it in place.
// You should not need to change this, beware if you are.
if (typeof window !== "undefined") {
    // Load in the instruments and then start your game!
    const samples = SampleLibrary.load({
        instruments: [
            "bass-electric",
            "violin",
            "piano",
            "trumpet",
            "saxophone",
            "trombone",
            "flute",
        ], // SampleLibrary.list,
        baseUrl: "samples/",
    });

    const startGame = (contents: string) => {
        document.body.addEventListener(
            "mousedown",
            function () {
                main(contents, samples);
            },
            { once: true },
        );
    };

    const { protocol, hostname, port } = new URL(import.meta.url);
    const baseUrl = `${protocol}//${hostname}${port ? `:${port}` : ""}`;

    Tone.ToneAudioBuffer.loaded().then(() => {
        for (const instrument in samples) {
            samples[instrument].toDestination();
            samples[instrument].release = 0.5;
        }

        fetch(`${baseUrl}/assets/${Constants.SONG_NAME}.csv`)
            .then((response) => response.text())
            .then((text) => startGame(text))
            .catch((error) =>
                console.error("Error fetching the CSV file:", error),
            );
    });
}
