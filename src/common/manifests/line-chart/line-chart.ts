/*
 * Copyright 2015-2016 Imply Data, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { List } from 'immutable';
import { $, SortAction } from 'plywood';
import { Splits, DataCube, SplitCombine, Colors, Dimension } from '../../models/index';
import {
  CircumstancesHandler
} from '../../utils/circumstances-handler/circumstances-handler';
import { Manifest, Resolve } from '../../models/manifest/manifest';

function adjustSingleSplit(splits: Splits, dataCube: DataCube, colors: Colors): any {
  var bucketedSplit = splits.get(0);
  var continuousDimension = dataCube.getDimensionByExpression(bucketedSplit.expression);
  var sortStrategy = continuousDimension.sortStrategy;

  var sortAction: SortAction = null;
  if (sortStrategy && sortStrategy !== 'self') {
    sortAction = new SortAction({
      expression: $(sortStrategy),
      direction: SortAction.ASCENDING
    });
  } else {
    sortAction = new SortAction({
      expression: $(continuousDimension.name),
      direction: SortAction.ASCENDING
    });
  }

  let autoChanged = false;

  // Fix time sort
  if (!sortAction.equals(bucketedSplit.sortAction)) {
    bucketedSplit = bucketedSplit.changeSortAction(sortAction);
    autoChanged = true;
  }

  // Fix time limit
  if (bucketedSplit.limitAction && continuousDimension.kind === 'time') {
    bucketedSplit = bucketedSplit.changeLimitAction(null);
    autoChanged = true;
  }

  if (colors) {
    autoChanged = true;
  }

  return {
    score: (score: (split: SplitCombine, dimension: Dimension, autoChanged: boolean) => Resolve) => {
      return score(bucketedSplit, continuousDimension, autoChanged);
    }
  };
}


function handleTwoSplits(primarySplit: SplitCombine, colorSplit: SplitCombine, dataCube: DataCube, colors: Colors): Resolve {
  var primaryDimension = primarySplit.getDimension(dataCube.dimensions);
  let autoChanged = false;

  var sortAction: SortAction = new SortAction({
    expression: $(primaryDimension.name),
    direction: SortAction.ASCENDING
  });

  // Fix time sort
  if (!sortAction.equals(primarySplit.sortAction)) {
    primarySplit = primarySplit.changeSortAction(sortAction);
    autoChanged = true;
  }

  // Fix time limit
  if (primarySplit.limitAction && primaryDimension.kind === 'time') {
    primarySplit = primarySplit.changeLimitAction(null);
    autoChanged = true;
  }

  if (!colorSplit.sortAction) {
    colorSplit = colorSplit.changeSortAction(dataCube.getDefaultSortAction());
    autoChanged = true;
  }

  var colorSplitDimension = dataCube.getDimensionByExpression(colorSplit.expression);
  if (!colors || colors.dimension !== colorSplitDimension.name) {
    colors = Colors.fromLimit(colorSplitDimension.name, 5);
    autoChanged = true;
  }
  return resolveTwoSplits({ primarySplit, colorSplit, primaryDimension, colors, autoChanged });
}

interface LineChartState {
  primarySplit: SplitCombine;
  colorSplit: SplitCombine;
  primaryDimension: Dimension;
  colors: Colors;
  autoChanged: Boolean;
}

function resolveTwoSplits(state: LineChartState): Resolve {
  const { primaryDimension, autoChanged, colorSplit, primarySplit, colors } = state;
  let score = 4;
  if (primaryDimension.canBucketByDefault()) score += 2;
  if (primaryDimension.kind === 'time') score += 2;
  if (!autoChanged) {
    score += 2;
    return Resolve.ready(score);
  }
  return Resolve.automatic(score, {
    splits: new Splits(List([colorSplit, primarySplit])),
    colors
  });
}

interface TwoSplitCandidate {
  primaryCandidate: SplitCombine;
  colorCandidate: SplitCombine;
  dimensions: List<Dimension>;
  splits: Splits;
}

interface TwoSplitResult {
  primarySplit: SplitCombine;
  colorSplit: SplitCombine;
}

function ensureSplitOrder(candidate: TwoSplitCandidate): TwoSplitResult {
  const { splits, dimensions, primaryCandidate, colorCandidate } = candidate;
  if (splits.toArray().every((s) => s.isBucketed())) {
    var timeSplit = List(splits.toArray()).find((s) => s.getDimension(dimensions).kind === 'time');
    if (timeSplit && primaryCandidate !== timeSplit) {
      return { primarySplit: timeSplit, colorSplit: primaryCandidate };
    }
  }
  return { primarySplit: primaryCandidate, colorSplit: colorCandidate};
}

var handler = CircumstancesHandler.EMPTY()

  .when((splits: Splits) => !(splits.toArray().some((s) => s.isBucketed())))
  .then((splits: Splits, dataCube: DataCube) => {
    let bucketedDimensions = dataCube.dimensions.filter((d) => d.canBucketByDefault());
    return Resolve.manual(3, 'This visualization requires a continuous dimension split',
      bucketedDimensions.toArray().map((dimension) => {
        return {
          description: `Add a split on ${dimension.title}`,
          adjustment: {
            splits: Splits.fromSplitCombine(SplitCombine.fromExpression(dimension.expression))
          }
        };
      })
    );
  })

  .when((splits: Splits) => {
    return splits.hasSplitsLength(1) && splits.first().isBucketed();
  })
  .then((splits: Splits, dataCube: DataCube, colors: Colors, current: boolean) => {
    return adjustSingleSplit(splits, dataCube, colors)
      .score((split: SplitCombine, dimension: Dimension, autoChanged: boolean) => {
        var score = 5;
        if (split.canBucketByDefault(dataCube.dimensions)) score += 2;
        if (dimension.kind === 'time') score += 3;
        if (current) score = 10;
        if (!autoChanged) {
          if (score !== 10) score += 2;
          return Resolve.ready(score);
        }
        return Resolve.automatic(score, {splits: new Splits(List([split]))});
    });
  })

  .when((splits: Splits) => splits.length() === 2 && splits.first().isBucketed())
  .then((splits: Splits, dataCube: DataCube, colors: Colors) => {
    let primaryCandidate = splits.get(0);
    let colorCandidate = splits.get(1);
    const { dimensions } = dataCube;
    const { primarySplit, colorSplit } = ensureSplitOrder({ primaryCandidate, colorCandidate, splits, dimensions });
    return handleTwoSplits(primarySplit, colorSplit, dataCube, colors);
  })

  .when((splits: Splits) => splits.length() === 2 && splits.get(1).isBucketed())
  .then((splits: Splits, dataCube: DataCube, colors: Colors) => {
    var primaryCandidate = splits.get(1);
    let colorCandidate = splits.get(0);
    const { dimensions } = dataCube;
    const { primarySplit, colorSplit } = ensureSplitOrder({ primaryCandidate, colorCandidate, splits, dimensions });
    return handleTwoSplits(primarySplit, colorSplit, dataCube, colors);
  })

  .when((splits: Splits) => splits.toArray().some((s) => s.isBucketed()))
  .then((splits: Splits) => {
    let firstBucketableSplit = splits.toArray().filter((split) => split.isBucketed())[0];
    return Resolve.manual(3, 'Too many splits on the line chart', [
      {
        description: `Remove all but the first bucketed split`,
        adjustment: {
          splits: Splits.fromSplitCombine(firstBucketableSplit)
        }
      }
    ]);
  })

  .otherwise(
    (splits: Splits, dataCube: DataCube) => {
      let bucketableDimensions = dataCube.dimensions.filter(d => d.canBucketByDefault());
      return Resolve.manual(3, 'The Line Chart needs one bucketed split',
        bucketableDimensions.toArray().map((continuousDimension) => {
          return {
            description: `Split on ${continuousDimension.title} instead`,
            adjustment: {
              splits: Splits.fromSplitCombine(SplitCombine.fromExpression(continuousDimension.expression))
            }
          };
        })
      );
    }
  );


export const LINE_CHART_MANIFEST = new Manifest(
  'line-chart',
  'Line Chart',
  handler.evaluate.bind(handler)
);
