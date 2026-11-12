// The 10,000 codenames Lens gives clients when client anonymisation is used (src/core/anonymise.ts): one of
// 100 short adjectives and one of 100 short animals, each word 3 to 5 letters, so every codename is at most 11
// characters ("Teal Wren", "Calm Lynx"). No word is a finance or company word (Gold, Royal, Bank, Trust,
// Capital…) or an unkind one, so a codename never sounds like a client or like a judgement of one.
export const CODENAME_ADJECTIVES = [
    'Amber', 'Aqua', 'Ashen', 'Azure', 'Bold', 'Brave', 'Brisk', 'Calm', 'Clear', 'Cool', 'Coral', 'Cozy', 'Crisp', 'Dawn',
    'Deep', 'Dusk', 'Dusky', 'Eager', 'Early', 'Even', 'Fair', 'Fern', 'Fine', 'Fleet', 'Fresh', 'Frost', 'Glad', 'Green',
    'Grey', 'Happy', 'Hazel', 'Honey', 'Icy', 'Ivory', 'Jade', 'Jolly', 'Keen', 'Kind', 'Lemon', 'Lilac', 'Lime', 'Lofty',
    'Lucky', 'Lunar', 'Merry', 'Mild', 'Mint', 'Misty', 'Mossy', 'Neat', 'Noble', 'Ochre', 'Olive', 'Opal', 'Pale', 'Peach',
    'Pearl', 'Pink', 'Plum', 'Polar', 'Proud', 'Quick', 'Quiet', 'Rapid', 'Rosy', 'Ruby', 'Rust', 'Sable', 'Sage', 'Sandy',
    'Sharp', 'Shy', 'Silky', 'Slate', 'Sleek', 'Snowy', 'Solar', 'Spry', 'Still', 'Sunny', 'Sweet', 'Swift', 'Tawny', 'Teal',
    'Tidy', 'Vivid', 'Warm', 'Wild', 'Wise', 'Witty', 'Zesty', 'Cloud', 'Cocoa', 'Dandy', 'Dewy', 'Fuzzy', 'Hardy', 'Leafy',
    'Lush', 'Plush',
] as const
export const CODENAME_ANIMALS = [
    'Ant', 'Asp', 'Bat', 'Bear', 'Bee', 'Bison', 'Boar', 'Buck', 'Calf', 'Carp', 'Cat', 'Cod', 'Colt', 'Crab',
    'Crane', 'Crow', 'Cub', 'Deer', 'Dodo', 'Doe', 'Dove', 'Duck', 'Eagle', 'Eel', 'Egret', 'Eland', 'Elk', 'Emu',
    'Fawn', 'Finch', 'Fox', 'Frog', 'Gecko', 'Gnu', 'Goat', 'Goose', 'Gull', 'Hare', 'Hawk', 'Hen', 'Heron', 'Horse',
    'Hound', 'Ibex', 'Ibis', 'Jay', 'Kite', 'Kiwi', 'Koala', 'Krill', 'Lark', 'Lemur', 'Lion', 'Llama', 'Loon', 'Lynx',
    'Mink', 'Mole', 'Moose', 'Moth', 'Mouse', 'Mule', 'Newt', 'Okapi', 'Orca', 'Otter', 'Owl', 'Panda', 'Puma', 'Quail',
    'Ram', 'Raven', 'Robin', 'Rook', 'Seal', 'Shrew', 'Sloth', 'Snail', 'Snipe', 'Squid', 'Stag', 'Stork', 'Swan', 'Tapir',
    'Tern', 'Tiger', 'Toad', 'Trout', 'Tuna', 'Vole', 'Whale', 'Wolf', 'Wren', 'Yak', 'Zebra', 'Bream', 'Dingo', 'Guppy',
    'Hippo', 'Macaw',
] as const
/** All 10,000, in a fixed order: adjective by adjective. */
export const CODENAMES: readonly string[] = CODENAME_ADJECTIVES.flatMap((a) => CODENAME_ANIMALS.map((n) => `${a} ${n}`))
