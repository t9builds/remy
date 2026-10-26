/**
 * Session nicknames: well-known dishes and ingredients, one lowercase word each. remy names every session it sees
 * with one of these (see names.ts), so a name is easy to say and type from a phone.
 * Rules, checked by nickname.test.ts: no duplicates, a-z only, and no name inside another, because
 * `claude attach` and `claude logs` also match part of a name.
 */
export const KITCHEN_NAMES = [
  // Herbs and spices
  "basil", "saffron", "garlic", "ginger", "pepper", "paprika", "cumin", "nutmeg", "cinnamon", "vanilla",
  "mint", "thyme", "rosemary", "oregano", "parsley", "dill", "sage", "chili", "wasabi", "turmeric",
  // Fruit
  "lemon", "lime", "orange", "mango", "banana", "cherry", "apple", "pear", "peach", "plum",
  "grape", "kiwi", "coconut", "papaya", "apricot", "raspberry", "blueberry", "strawberry", "fig", "melon",
  // Vegetables
  "tomato", "potato", "onion", "carrot", "celery", "spinach", "kale", "cabbage", "broccoli", "pumpkin",
  "zucchini", "eggplant", "avocado", "olive", "radish", "beetroot", "artichoke", "asparagus", "leek", "truffle",
  // Nuts, grains and pantry
  "almond", "walnut", "pecan", "cashew", "pistachio", "hazelnut", "peanut", "chestnut", "sesame", "lentil",
  "chickpea", "quinoa", "honey", "butter", "maple", "cocoa", "coffee", "espresso", "mocha", "matcha",
  // Cheese
  "mozzarella", "parmesan", "feta", "brie", "gouda", "cheddar", "burrata", "ricotta",
  // Dishes
  "pizza", "pasta", "lasagna", "ravioli", "risotto", "gnocchi", "paella", "sushi", "ramen", "udon",
  "tempura", "curry", "taco", "burrito", "nachos", "falafel", "hummus", "kebab", "goulash", "pierogi",
  "dumpling", "omelette", "quiche", "fondue", "ratatouille", "bruschetta", "focaccia", "tortilla", "burger", "sandwich",
  "pesto", "salsa", "guacamole", "polenta", "couscous", "biryani", "samosa", "naan", "kimchi", "bibimbap",
  "pho", "tofu", "miso", "teriyaki", "edamame", "wonton", "noodle", "meatball", "schnitzel", "chowder",
  "gumbo", "jambalaya", "gazpacho", "minestrone", "carbonara", "pickle",
  // Bakery and sweets
  "croissant", "baguette", "brioche", "pretzel", "bagel", "waffle", "pancake", "crepe", "muffin", "cookie",
  "brownie", "cupcake", "donut", "cheesecake", "tiramisu", "macaron", "eclair", "strudel", "souffle", "churro",
  "flan", "baklava", "cannoli", "gelato", "sorbet", "pudding", "scone", "biscuit", "nougat", "praline",
  "marzipan", "meringue", "custard", "caramel", "toffee", "fudge", "granola", "yogurt", "popsicle", "panettone",
];
